import { createHash } from "node:crypto";
import { z } from "zod";
import { dayIn, notify, reserveBudget, settleBudget } from "./budget";
import { json, num, one, parseJson, type Sql } from "./db";
import { loadMemory } from "./memory";
import { buildSystemPrompt, ROLE_INFO } from "./persona";
import { decideApproval, loadRules } from "./policy";
import { costUsd, loadPrice, worstCaseUsd, type Price } from "./pricing";
import type { ModelDriver, StepResponse, ToolSpec, Turn } from "./providers";
import { TOOLS_BY_NAME, ToolError, toolJsonSchema, type ToolDef } from "./tools";
import type { RunStatus, ToolCall, ToolResult, Xodo } from "./types";

/**
 * O executor dos Xodós: um laço de passos com o modelo, no estilo do Rakazo e do OpenDots.
 *
 * Cada passo reserva o pior caso no teto do dia, chama o modelo, acerta o custo real e
 * trata as ferramentas pedidas. O que pode rodar direto roda; o que precisa de aprovação
 * vira um pedido guardado em xodo_actions e a execução para em waiting_approval. Quando a
 * equipe decide, o servidor executa exatamente o input guardado, uma vez só, e retoma.
 */

export const MAX_STEPS = 12;
export const MAX_TOKENS_PER_STEP = 8_000;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Uma execução "running" parada há mais que isso é tratada como travada. */
export const STALE_RUN_MS = 10 * 60 * 1000;
const TRANSCRIPT_MESSAGES = 20;
const TOOL_RESULT_MAX_CHARS = 20_000;

export type EngineDeps = {
  sql: Sql;
  /** Cria o adaptador do modelo do xodó (com a chave da agência). Nos testes, um modelo falso. */
  driverFor: (xodo: Xodo) => Promise<ModelDriver>;
  now?: () => Date;
};

export class XodoError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const nowOf = (deps: EngineDeps) => (deps.now ? deps.now() : new Date());

// ---------------------------------------------------------------------------
// Leituras
// ---------------------------------------------------------------------------

export async function loadXodo(sql: Sql, xodoId: string, agencyId?: string): Promise<Xodo> {
  const xodo = await one<Xodo>(
    sql,
    `select * from xodos where id = $1 and ($2::uuid is null or agency_id = $2::uuid)`,
    [xodoId, agencyId ?? null],
  );
  if (!xodo) throw new XodoError("Xodó não encontrado", 404);
  return xodo;
}

type RunRow = {
  id: string;
  xodo_id: string;
  agency_id: string;
  trigger: "user" | "routine";
  routine_id: string | null;
  status: RunStatus;
  native_messages: unknown;
  steps: number;
  tool_calls: number;
  final_text: string | null;
};

async function loadRun(sql: Sql, runId: string): Promise<RunRow> {
  const run = await one<RunRow>(sql, `select * from xodo_runs where id = $1`, [runId]);
  if (!run) throw new XodoError("Execução não encontrada", 404);
  return run;
}

export async function enabledTools(sql: Sql, xodo: Xodo): Promise<ToolDef[]> {
  const rows = await sql.query<{ tool_name: string; enabled: boolean }>(
    `select tool_name, enabled from xodo_tools where xodo_id = $1 and agency_id = $2`,
    [xodo.id, xodo.agency_id],
  );
  const names = rows.length ? rows.filter((r) => r.enabled).map((r) => r.tool_name) : ROLE_INFO[xodo.role].tools;
  return names.flatMap((name) => {
    const def = TOOLS_BY_NAME.get(name);
    return def ? [def] : [];
  });
}

async function clientsInScope(sql: Sql, xodo: Xodo) {
  return sql.query<{ id: string; name: string }>(
    `select c.id, c.name from clients c
      where c.agency_id = $1
        and ($2 = 'all' or exists (select 1 from xodo_clients xc where xc.xodo_id = $3 and xc.client_id = c.id))
      order by c.name limit 50`,
    [xodo.agency_id, xodo.client_scope, xodo.id],
  );
}

async function requirePrice(sql: Sql, xodo: Xodo): Promise<Price> {
  const price = await loadPrice(sql, xodo.provider, xodo.model);
  // Sem preço não há como garantir o teto do dia, então o xodó não roda.
  if (!price) throw new XodoError(`O modelo ${xodo.model} não tem preço cadastrado; peça ao admin para cadastrar.`, 422);
  return price;
}

// ---------------------------------------------------------------------------
// Início de uma execução
// ---------------------------------------------------------------------------

export type StartInput = {
  xodoId: string;
  agencyId: string;
  trigger: "user" | "routine";
  text: string;
  userId?: string | null;
  routineId?: string | null;
};

/** Cria a execução e grava a conversa inicial. Quem chama segue com continueRun(). */
export async function startRun(deps: EngineDeps, input: StartInput): Promise<string> {
  const { sql } = deps;
  const xodo = await loadXodo(sql, input.xodoId, input.agencyId);
  if (xodo.status !== "active") throw new XodoError(`${xodo.name} está pausado.`, 409);
  await requirePrice(sql, xodo);
  const text = input.text.trim();
  if (!text || text.length > 8000) throw new XodoError("Mensagem vazia ou longa demais (máximo de 8000 caracteres).");

  // Prepara o modelo antes de criar a execução: chave revogada falha aqui, sem deixar nada pela metade.
  const driver = await deps.driverFor(xodo);
  const now = nowOf(deps);
  if (input.trigger === "user") {
    const busy = await one(
      sql,
      `select 1 from xodo_runs where xodo_id = $1 and status = 'running' and heartbeat_at > $2::timestamptz`,
      [xodo.id, new Date(now.getTime() - STALE_RUN_MS).toISOString()],
    );
    if (busy) throw new XodoError(`${xodo.name} ainda está trabalhando no pedido anterior.`, 409);
  }

  const run = await one<{ id: string }>(
    sql,
    `insert into xodo_runs (xodo_id, agency_id, trigger, routine_id, requested_by, provider, model, started_at, heartbeat_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz) returning id`,
    [xodo.id, xodo.agency_id, input.trigger, input.routineId ?? null, input.userId ?? null, xodo.provider, xodo.model, now.toISOString()],
  );
  const runId = run!.id;

  if (input.trigger === "user") await addMessage(sql, xodo, runId, "user", text, input.userId ?? null);

  const recent = await sql.query<{ role: "user" | "assistant"; text: string }>(
    `select role, text from (
       select id, role, text from xodo_messages
        where xodo_id = $1 and agency_id = $2 and role in ('user', 'assistant')
        order by id desc limit $3
     ) m order by id`,
    [xodo.id, xodo.agency_id, TRANSCRIPT_MESSAGES],
  );
  const turns: Turn[] = recent.map((m) => ({ role: m.role, text: m.text }));
  if (input.trigger === "routine") turns.push({ role: "user", text });

  await sql.query(`update xodo_runs set native_messages = $2::jsonb where id = $1`, [runId, json(driver.start(turns))]);
  return runId;
}

// ---------------------------------------------------------------------------
// O laço
// ---------------------------------------------------------------------------

export async function continueRun(deps: EngineDeps, runId: string): Promise<RunStatus> {
  const { sql } = deps;
  const run = await loadRun(sql, runId);
  if (run.status !== "running") return run.status;
  const xodo = await loadXodo(sql, run.xodo_id, run.agency_id);

  try {
    const price = await requirePrice(sql, xodo);
    const driver = await deps.driverFor(xodo);
    const tools = await enabledTools(sql, xodo);
    const specs: ToolSpec[] = tools.map((t) => ({ name: t.name, description: t.description, parameters: toolJsonSchema(t) }));
    const system = await systemPromptFor(sql, xodo, run, nowOf(deps));
    const fixedChars = system.length + JSON.stringify(specs).length;
    const prices = new Map<string, Price>([[price.model, price]]);

    let history = parseJson<unknown[]>(run.native_messages);
    let steps = run.steps;

    while (true) {
      if (steps >= MAX_STEPS) {
        return finish(sql, xodo, runId, "completed", {
          text: "Parei aqui porque cheguei no limite de passos desta tarefa. Me diga se devo continuar.",
        });
      }

      const day = dayIn(xodo.timezone, nowOf(deps));
      const estimate = worstCaseUsd(price, fixedChars + JSON.stringify(history).length, MAX_TOKENS_PER_STEP);
      const reservation = await reserveBudget(sql, xodo, day, estimate);
      if (!reservation.ok) {
        return finish(sql, xodo, runId, "paused_budget", {
          note: `Pausei: o teto de hoje (US$ ${reservation.cap.toFixed(2)}) não comporta o próximo passo. Volto amanhã ou quando o teto for aumentado.`,
        });
      }

      let step: StepResponse;
      try {
        step = await driver.step({ system, history, tools: specs, maxTokens: MAX_TOKENS_PER_STEP });
      } catch (error) {
        await settleBudget(sql, xodo, day, estimate, 0);
        return finish(sql, xodo, runId, "failed", { error: providerErrorMessage(error) });
      }
      steps += 1;

      let actual = 0;
      for (const [i, slice] of step.usage.entries()) {
        let slicePrice = prices.get(slice.model);
        if (!slicePrice) {
          // Modelo de fallback sem preço próprio: cobra pelo preço do modelo pedido.
          slicePrice = (await loadPrice(sql, xodo.provider, slice.model)) ?? price;
          prices.set(slice.model, slicePrice);
        }
        const cost = costUsd(slicePrice, slice.usage);
        actual += cost;
        await sql.query(
          `insert into ai_usage (agency_id, xodo_id, run_id, provider, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, cost_usd, cost_source, pricing_version, call_id, day)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'list_price', $11, $12, $13::date)
           on conflict (call_id) do nothing`,
          [xodo.agency_id, xodo.id, runId, xodo.provider, slice.model, slice.usage.inputTokens, slice.usage.outputTokens,
            slice.usage.cacheReadTokens, slice.usage.cacheWriteTokens, cost, slicePrice.version, `${runId}:${steps}:${i}`, day],
        );
      }
      await settleBudget(sql, xodo, day, estimate, actual);

      history = step.history;
      await sql.query(
        `update xodo_runs set native_messages = $2::jsonb, steps = $3, tool_calls = tool_calls + $4, heartbeat_at = $5::timestamptz
          where id = $1`,
        [runId, json(history), steps, step.toolCalls.length, nowOf(deps).toISOString()],
      );

      if (step.stop === "refusal") {
        return finish(sql, xodo, runId, "refused", {
          text: step.text.trim() || "Não posso ajudar com esse pedido.",
        });
      }
      if (step.stop !== "tool_use") {
        const text = step.text.trim() || "(sem resposta)";
        const cut = step.stop === "max_tokens" ? "\n\n(Minha resposta foi cortada por tamanho.)" : "";
        return finish(sql, xodo, runId, "completed", { text: text + cut });
      }

      if (step.text.trim()) await addMessage(sql, xodo, runId, "assistant", step.text.trim(), null);

      const pending = await handleToolCalls(deps, xodo, runId, steps, step.toolCalls, tools);
      if (pending.length) {
        await sql.query(`update xodo_runs set status = 'waiting_approval' where id = $1`, [runId]);
        const list = pending.map((p) => `• ${p}`).join("\n");
        await addMessage(sql, xodo, runId, "note", `Preciso de aprovação para:\n${list}`, null);
        await notify(sql, xodo.agency_id, {
          kind: "approval_pending",
          title: `${xodo.name} pede aprovação`,
          body: pending.join("; "),
          data: { xodo_id: xodo.id, run_id: runId },
        });
        return "waiting_approval";
      }
      history = driver.addToolResults(history, await stepResults(sql, runId, steps));
      await sql.query(`update xodo_runs set native_messages = $2::jsonb, heartbeat_at = $3::timestamptz where id = $1`, [
        runId,
        json(history),
        nowOf(deps).toISOString(),
      ]);
    }
  } catch (error) {
    if (error instanceof XodoError) return finish(sql, xodo, runId, "failed", { error: error.message });
    await finish(sql, xodo, runId, "failed", { error: "Erro interno no motor dos Xodós." });
    throw error;
  }
}

async function systemPromptFor(sql: Sql, xodo: Xodo, run: RunRow, now: Date) {
  const agency = await one<{ name: string }>(sql, `select name from agencies where id = $1`, [xodo.agency_id]);
  const routine = run.routine_id
    ? await one<{ name: string; last_summary: string | null }>(
        sql,
        `select name, last_summary from xodo_routines where id = $1 and agency_id = $2`,
        [run.routine_id, xodo.agency_id],
      )
    : null;
  return buildSystemPrompt(xodo, {
    agencyName: agency?.name ?? "",
    today: dayIn(xodo.timezone, now),
    memory: await loadMemory(sql, xodo.agency_id, xodo.id),
    clients: await clientsInScope(sql, xodo),
    routine: routine ? { name: routine.name, lastSummary: routine.last_summary } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Ferramentas e pedidos de aprovação
// ---------------------------------------------------------------------------

/** Registra todas as chamadas do passo, roda as liberadas e devolve o resumo das que esperam aprovação. */
async function handleToolCalls(
  deps: EngineDeps,
  xodo: Xodo,
  runId: string,
  step: number,
  calls: ToolCall[],
  tools: ToolDef[],
): Promise<string[]> {
  const { sql } = deps;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const rules = await loadRules(sql, xodo.agency_id, xodo.id);
  const pending: string[] = [];
  const now = nowOf(deps);

  for (const [index, call] of calls.entries()) {
    const base = [runId, xodo.id, xodo.agency_id, call.name, call.id, step, index];
    const tool = byName.get(call.name);
    if (!tool) {
      await insertAction(sql, base, "desconhecida", call.input, "failed", { error: "Ferramenta indisponível para este xodó." });
      continue;
    }
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      await insertAction(sql, base, tool.category, call.input, "failed", {
        error: `Entrada inválida: ${z.prettifyError(parsed.error)}`,
      });
      continue;
    }
    const decision = decideApproval({ toolName: tool.name, category: tool.category, rules });
    if (decision.decision === "ask") {
      await insertAction(sql, base, tool.category, parsed.data, "pending", null, {
        reason: decision.source,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      });
      pending.push(tool.summarize(parsed.data));
      continue;
    }
    const actionId = await insertAction(sql, base, tool.category, parsed.data, "executing", null);
    await runAction(deps, xodo, actionId);
  }
  return pending;
}

async function insertAction(
  sql: Sql,
  base: unknown[],
  category: string,
  input: unknown,
  status: "pending" | "executing" | "failed",
  result: unknown,
  extra: { reason?: string; expiresAt?: Date } = {},
): Promise<string> {
  const row = await one<{ id: string }>(
    sql,
    `insert into xodo_actions (run_id, xodo_id, agency_id, tool_name, tool_call_id, step, call_index,
       category, input, input_hash, status, result, reason, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14::timestamptz)
     on conflict (run_id, tool_call_id) do nothing
     returning id`,
    [...base, category, json(input), inputHash(input), status, result === null ? null : json(result),
      extra.reason ?? null, extra.expiresAt?.toISOString() ?? null],
  );
  if (!row) throw new XodoError("O modelo repetiu o id de uma chamada de ferramenta.", 502);
  return row.id;
}

/** Hash canônico (chaves ordenadas) do input guardado. */
export function inputHash(input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as object)
          .sort()
          .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(input ?? null))).digest("hex");
}

/**
 * Executa uma ação já marcada como "executing" com o input guardado no banco.
 * Quem chama garante a transição para "executing" (que só acontece uma vez).
 */
export async function runAction(deps: EngineDeps, xodo: Xodo, actionId: string) {
  const { sql } = deps;
  const action = await one<{ tool_name: string; input: unknown; input_hash: string; run_id: string; status: string }>(
    sql,
    `select tool_name, input, input_hash, run_id, status from xodo_actions where id = $1 and agency_id = $2`,
    [actionId, xodo.agency_id],
  );
  if (!action || action.status !== "executing") throw new XodoError("Ação não está pronta para executar", 409);
  const input = parseJson<unknown>(action.input);
  const tool = TOOLS_BY_NAME.get(action.tool_name);

  let status: "executed" | "failed" = "failed";
  let result: unknown;
  if (!tool) {
    result = { error: "Ferramenta não existe mais." };
  } else if (inputHash(input) !== action.input_hash) {
    result = { error: "O pedido guardado foi alterado depois de criado; nada foi executado." };
  } else {
    try {
      const data = await tool.execute({ sql, xodo, runId: action.run_id, now: nowOf(deps) }, tool.input.parse(input));
      status = "executed";
      result = { data };
    } catch (error) {
      if (!(error instanceof ToolError)) console.error("[xodos] erro na ferramenta", action.tool_name, error);
      result = { error: error instanceof ToolError ? error.message : "Erro interno ao executar a ferramenta." };
    }
  }
  await sql.query(
    `update xodo_actions set status = $2, result = $3::jsonb, executed_at = $4::timestamptz where id = $1`,
    [actionId, status, json(result), nowOf(deps).toISOString()],
  );
}

/** Resultados das chamadas de um passo, na ordem em que o modelo pediu. */
async function stepResults(sql: Sql, runId: string, step: number): Promise<ToolResult[]> {
  const rows = await sql.query<{ tool_call_id: string; tool_name: string; status: string; result: unknown; reason: string | null }>(
    `select tool_call_id, tool_name, status, result, reason from xodo_actions
      where run_id = $1 and step = $2 order by call_index`,
    [runId, step],
  );
  return rows.map((row) => {
    const result = row.result === null ? {} : parseJson<{ data?: unknown; error?: string }>(row.result);
    const base = { id: row.tool_call_id, name: row.tool_name };
    switch (row.status) {
      case "executed":
        return { ...base, isError: false, content: truncate(JSON.stringify(result.data ?? null)) };
      case "denied":
        return { ...base, isError: true, content: `A equipe negou esta ação.${row.reason ? ` Motivo: ${row.reason}` : ""}` };
      case "expired":
        return { ...base, isError: true, content: "O pedido de aprovação expirou sem resposta. Nada foi feito." };
      case "failed":
        return { ...base, isError: true, content: result.error ?? "Falhou." };
      default:
        throw new XodoError(`Ação ${row.tool_call_id} ainda está ${row.status}`, 409);
    }
  });
}

function truncate(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}… (cortado)` : text;
}

// ---------------------------------------------------------------------------
// Retomada depois das decisões
// ---------------------------------------------------------------------------

/**
 * Retoma uma execução que esperava aprovação, se todas as ações do passo já foram
 * decididas. A troca de status é atômica: duas decisões simultâneas retomam uma vez só.
 */
export async function resumeRun(deps: EngineDeps, runId: string): Promise<RunStatus | null> {
  const { sql } = deps;
  const claimed = await one<RunRow>(
    sql,
    `update xodo_runs r set status = 'running', heartbeat_at = $2::timestamptz
      where r.id = $1 and r.status = 'waiting_approval'
        and not exists (
          select 1 from xodo_actions a
           where a.run_id = r.id and a.step = r.steps and a.status in ('pending', 'approved', 'executing'))
      returning *`,
    [runId, nowOf(deps).toISOString()],
  );
  if (!claimed) return null;
  const xodo = await loadXodo(sql, claimed.xodo_id, claimed.agency_id);
  const driver = await deps.driverFor(xodo);
  const history = driver.addToolResults(parseJson<unknown[]>(claimed.native_messages), await stepResults(sql, runId, claimed.steps));
  await sql.query(`update xodo_runs set native_messages = $2::jsonb where id = $1`, [runId, json(history)]);
  return continueRun(deps, runId);
}

// ---------------------------------------------------------------------------
// Fim
// ---------------------------------------------------------------------------

async function finish(
  sql: Sql,
  xodo: Xodo,
  runId: string,
  status: RunStatus,
  out: { text?: string; note?: string; error?: string },
): Promise<RunStatus> {
  await sql.query(
    `update xodo_runs set status = $2, final_text = coalesce($3, final_text), error = $4, finished_at = now() where id = $1`,
    [runId, status, out.text ?? out.note ?? null, out.error ?? null],
  );
  if (out.text) await addMessage(sql, xodo, runId, "assistant", out.text, null);
  if (out.note) await addMessage(sql, xodo, runId, "note", out.note, null);
  if (out.error) await addMessage(sql, xodo, runId, "note", `Não consegui terminar: ${out.error}`, null);
  return status;
}

export async function addMessage(
  sql: Sql,
  xodo: Pick<Xodo, "id" | "agency_id">,
  runId: string | null,
  role: "user" | "assistant" | "note",
  text: string,
  authorUser: string | null,
) {
  await sql.query(
    `insert into xodo_messages (xodo_id, agency_id, run_id, role, author_user, text) values ($1, $2, $3, $4, $5, $6)`,
    [xodo.id, xodo.agency_id, runId, role, authorUser, text],
  );
}

export function providerErrorMessage(error: unknown): string {
  const status = num((error as { status?: unknown })?.status);
  if (status === 401 || status === 403) return "A chave de API foi recusada pelo provedor. Confira a chave da agência.";
  if (status === 429) return "O provedor limitou as chamadas desta chave (limite de uso). Tente de novo em instantes.";
  if (status === 404) return "O provedor não encontrou o modelo configurado.";
  if (status >= 500) return "O provedor do modelo está instável agora. Tente de novo em instantes.";
  const message = error instanceof Error ? error.message : String(error);
  return `Falha ao chamar o modelo: ${message.slice(0, 300)}`;
}
