import { createHash } from "node:crypto";
import { Type, type AssistantMessage, type Message, type Tool, type ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { appAccess } from "../integrations/access";
import { IntegrationError } from "../integrations/http";
import { appToolsFor } from "../integrations/registry";
import type { IntegrationDeps } from "../integrations/store";
import { callWithFallback, loadCandidates, prepare, type BrainDeps } from "./brain";
import { dayIn, notify } from "./budget";
import { json, num, one, parseJson, type Sql } from "./db";
import { usdBrl } from "./fx";
import { providerErrorMessage } from "./llm";
import { loadMemory } from "./memory";
import { buildSystemPrompt, type PromptContext } from "./persona";
import { decideApproval, loadRules } from "./policy";
import { TOOLS, TOOLS_BY_NAME, ToolError, toolJsonSchema, type ToolContext, type ToolDef } from "./tools";
import type { Autonomy, RunStatus, ToolCall, ToolResult, Xodo } from "./types";

/**
 * O executor dos Xodós: um laço de passos com o modelo, no estilo do Rakazo e do OpenDots.
 *
 * Cada passo chama o cérebro do xodó (modelo principal ou um reserva), registra o gasto e
 * trata as ferramentas pedidas. O que pode rodar direto roda; o que precisa de aprovação
 * vira um pedido guardado em xodo_actions e a execução para em waiting_approval. Quando a
 * equipe decide, o servidor executa exatamente o input guardado, uma vez só, e retoma.
 */

export const MAX_STEPS = 12;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Uma execução "running" parada há mais que isso é tratada como travada. */
export const STALE_RUN_MS = 10 * 60 * 1000;
const TRANSCRIPT_MESSAGES = 20;
const TOOL_RESULT_MAX_CHARS = 20_000;

export type EngineDeps = BrainDeps & {
  now?: () => Date;
  /** Conexões com apps (chave do cofre, fetch, endereço do Spherum). Sem isto, só as ferramentas internas. */
  integrations?: Omit<IntegrationDeps, "sql" | "now">;
};

function integrationDeps(deps: EngineDeps): IntegrationDeps | null {
  return deps.integrations ? { ...deps.integrations, sql: deps.sql, now: deps.now } : null;
}

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

/** user: pela tela do app; channel: por Slack, WhatsApp ou Telegram; routine: rotina agendada; event: gatilho. */
export type RunTrigger = "user" | "routine" | "channel" | "event";

type RunRow = {
  id: string;
  xodo_id: string;
  agency_id: string;
  trigger: RunTrigger;
  routine_id: string | null;
  conversation_id: string | null;
  event_trigger_id: string | null;
  status: RunStatus;
  transcript: unknown;
  steps: number;
  tool_calls: number;
  final_text: string | null;
};

async function loadRun(sql: Sql, runId: string): Promise<RunRow> {
  const run = await one<RunRow>(sql, `select * from xodo_runs where id = $1`, [runId]);
  if (!run) throw new XodoError("Execução não encontrada", 404);
  return run;
}

async function disabledTools(sql: Sql, xodo: Xodo): Promise<Set<string>> {
  const off = await sql.query<{ tool_name: string }>(
    `select tool_name from xodo_tools where xodo_id = $1 and agency_id = $2 and not enabled`,
    [xodo.id, xodo.agency_id],
  );
  return new Set(off.map((r) => r.tool_name));
}

/** Ferramentas internas, menos as que a agência desligou para este xodó. */
export async function enabledTools(sql: Sql, xodo: Xodo): Promise<ToolDef[]> {
  const disabled = await disabledTools(sql, xodo);
  return TOOLS.filter((t) => !disabled.has(t.name));
}

/** Tudo que o xodó pode usar: ferramentas internas e as dos apps liberados para ele. */
export async function toolsFor(deps: EngineDeps, xodo: Xodo): Promise<ToolDef[]> {
  const disabled = await disabledTools(deps.sql, xodo);
  const apps = await appToolsFor(integrationDeps(deps), xodo);
  return [...TOOLS, ...apps].filter((t) => !disabled.has(t.name));
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

// ---------------------------------------------------------------------------
// Conversa no formato da pi-ai
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Mensagens visíveis anteriores viram turnos da conversa. Falas seguidas do mesmo lado são
 * juntadas e a conversa começa pelo usuário. As respostas antigas entram como texto de um
 * "modelo de histórico", que qualquer provedor aceita.
 */
export function historyMessages(turns: { role: "user" | "assistant"; text: string }[]): Message[] {
  const merged: { role: "user" | "assistant"; text: string }[] = [];
  for (const turn of turns) {
    if (!turn.text.trim()) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.text += `\n\n${turn.text}`;
    else merged.push({ ...turn });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged.map((t, i): Message =>
    t.role === "user"
      ? { role: "user", content: t.text, timestamp: i }
      : {
          role: "assistant",
          content: [{ type: "text", text: t.text }],
          api: "openai-completions",
          provider: "spherum-historico",
          model: "historico",
          usage: ZERO_USAGE,
          stopReason: "stop",
          timestamp: i,
        },
  );
}

function toolResultMessages(results: ToolResult[], at: number): ToolResultMessage[] {
  return results.map((r) => ({
    role: "toolResult",
    toolCallId: r.id,
    toolName: r.name,
    content: [{ type: "text", text: r.content }],
    isError: r.isError,
    timestamp: at,
  }));
}

function textOf(message: AssistantMessage): string {
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.flatMap((b) => (b.type === "toolCall" ? [{ id: b.id, name: b.name, input: b.arguments }] : []));
}

function piTools(tools: ToolDef[]): Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: Type.Unsafe(toolJsonSchema(t)) }));
}

// ---------------------------------------------------------------------------
// Início de uma execução
// ---------------------------------------------------------------------------

export type StartInput = {
  xodoId: string;
  agencyId: string;
  trigger: RunTrigger;
  text: string;
  userId?: string | null;
  routineId?: string | null;
  /** Conversa de canal (Slack, WhatsApp, Telegram); sem ela, é a conversa do app. */
  conversationId?: string | null;
  /** Quem falou pelo canal, para mostrar no app (ex.: "Ana pelo Slack"). */
  authorLabel?: string | null;
  eventTriggerId?: string | null;
};

/** Cria a execução e grava a conversa inicial. Quem chama segue com continueRun(). */
export async function startRun(deps: EngineDeps, input: StartInput): Promise<string> {
  const { sql } = deps;
  const xodo = await loadXodo(sql, input.xodoId, input.agencyId);
  if (xodo.status !== "active") throw new XodoError(`${xodo.name} está pausado.`, 409);
  const text = input.text.trim();
  if (!text || text.length > 8000) throw new XodoError("Mensagem vazia ou longa demais (máximo de 8000 caracteres).");

  // Confere o cérebro antes de criar a execução: sem nenhum modelo utilizável, nada fica pela metade.
  const problems: string[] = [];
  let usable = false;
  for (const candidate of await loadCandidates(sql, xodo, input.trigger)) {
    const ready = await prepare(deps, xodo, candidate);
    if ("problem" in ready) problems.push(ready.problem);
    else {
      usable = true;
      break;
    }
  }
  if (!usable) throw new XodoError(`${xodo.name} não tem um modelo utilizável: ${problems.join("; ")}.`, 422);

  const now = nowOf(deps);
  const conversationId = input.conversationId ?? null;
  const spoken = input.trigger === "user" || input.trigger === "channel";
  if (spoken) {
    // Um pedido por vez em cada conversa (a do app ou a de um canal).
    const busy = await one(
      sql,
      `select 1 from xodo_runs where xodo_id = $1 and status = 'running' and heartbeat_at > $2::timestamptz
          and conversation_id is not distinct from $3::uuid`,
      [xodo.id, new Date(now.getTime() - STALE_RUN_MS).toISOString(), conversationId],
    );
    if (busy) throw new XodoError(`${xodo.name} ainda está trabalhando no pedido anterior.`, 409);
  }

  const run = await one<{ id: string }>(
    sql,
    `insert into xodo_runs (xodo_id, agency_id, trigger, routine_id, requested_by, provider, model, started_at, heartbeat_at,
       conversation_id, event_trigger_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, $9, $10) returning id`,
    [xodo.id, xodo.agency_id, input.trigger, input.routineId ?? null, input.userId ?? null, xodo.provider, xodo.model, now.toISOString(),
      conversationId, input.eventTriggerId ?? null],
  );
  const runId = run!.id;

  if (spoken) await addMessage(sql, xodo, runId, "user", text, input.userId ?? null, { authorLabel: input.authorLabel ?? null });

  // Gatilho começa do zero: o evento vem de fora e não deve se misturar com a conversa.
  const recent =
    input.trigger === "event"
      ? []
      : await sql.query<{ role: "user" | "assistant"; text: string }>(
          `select role, text from (
             select id, role, text from xodo_messages
              where xodo_id = $1 and agency_id = $2 and role in ('user', 'assistant')
                and conversation_id is not distinct from $4::uuid
              order by id desc limit $3
           ) m order by id`,
          [xodo.id, xodo.agency_id, TRANSCRIPT_MESSAGES, conversationId],
        );
  const turns = recent.map((m) => ({ role: m.role, text: m.text }));
  if (!spoken) turns.push({ role: "user", text });

  await sql.query(`update xodo_runs set transcript = $2::jsonb where id = $1`, [runId, json(historyMessages(turns))]);
  return runId;
}

// ---------------------------------------------------------------------------
// O laço
// ---------------------------------------------------------------------------

export async function continueRun(deps: EngineDeps, runId: string): Promise<RunStatus> {
  const { sql } = deps;
  const run = await loadRun(sql, runId);
  if (run.status !== "running") return run.status;
  const xodo = await effectiveXodo(sql, run, await loadXodo(sql, run.xodo_id, run.agency_id));

  try {
    const tools = await toolsFor(deps, xodo);
    const systemPrompt = await systemPromptFor(sql, xodo, run, nowOf(deps));
    const candidates = await loadCandidates(sql, xodo, run.trigger);
    let messages = parseJson<Message[]>(run.transcript);
    let steps = run.steps;
    // Começa pelo modelo principal; se um reserva assumir, segue com ele até o fim da execução.
    let active = 0;

    while (true) {
      if (steps >= MAX_STEPS) {
        return finish(sql, xodo, runId, "completed", {
          text: "Parei aqui porque cheguei no limite de passos desta tarefa. Me diga se devo continuar.",
        });
      }

      const day = dayIn(xodo.timezone, nowOf(deps));
      const rate = await usdBrl(sql, day);
      if (xodo.daily_budget_brl !== null && rate === null) {
        return finish(sql, xodo, runId, "failed", {
          error: "Ainda não há cotação do dólar para garantir o teto em reais. Tente de novo em alguns minutos.",
        });
      }

      const result = await callWithFallback(deps, {
        xodo,
        runId,
        step: steps + 1,
        day,
        usdBrl: rate,
        context: { systemPrompt, messages, tools: piTools(tools) },
        candidates,
        startAt: active,
      });
      if (!result.ok && result.reason === "budget") {
        const cap = num(result.cap).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
        return finish(sql, xodo, runId, "paused_budget", {
          note: `Pausei: o teto de hoje (${cap}) não comporta o próximo passo. Volto amanhã ou quando o teto for aumentado.`,
        });
      }
      if (!result.ok && result.reason === "refused") {
        return finish(sql, xodo, runId, "refused", { text: "Não posso ajudar com esse pedido." });
      }
      if (!result.ok) {
        const reason = result.detail ? providerErrorMessage(result.detail) : `nenhum modelo pôde ser usado (${result.problems.join("; ")})`;
        return finish(sql, xodo, runId, "failed", { error: reason });
      }

      active = result.index;
      const message = result.message;
      const calls = toolCallsOf(message);
      steps += 1;
      messages = [...messages, message];
      await sql.query(
        `update xodo_runs set transcript = $2::jsonb, steps = $3, tool_calls = tool_calls + $4, heartbeat_at = $5::timestamptz
          where id = $1`,
        [runId, json(messages), steps, calls.length, nowOf(deps).toISOString()],
      );

      const text = textOf(message).trim();
      if (!calls.length) {
        const cut = message.stopReason === "length" ? "\n\n(Minha resposta foi cortada por tamanho.)" : "";
        return finish(sql, xodo, runId, "completed", { text: (text || "(sem resposta)") + cut });
      }

      if (text) await addMessage(sql, xodo, runId, "assistant", text, null);

      const pending = await handleToolCalls(deps, xodo, runId, steps, calls, tools);
      if (pending.length) {
        await sql.query(`update xodo_runs set status = 'waiting_approval' where id = $1`, [runId]);
        const list = pending.length === 1 ? `• ${pending[0].summary}` : pending.map((p, i) => `${i + 1}. ${p.summary}`).join("\n");
        await addMessage(sql, xodo, runId, "note", `Preciso de aprovação para:\n${list}`, null, { approvals: pending });
        await notify(sql, xodo.agency_id, {
          kind: "approval_pending",
          title: `${xodo.name} pede aprovação`,
          body: pending.map((p) => p.summary).join("; "),
          data: { xodo_id: xodo.id, run_id: runId },
        });
        return "waiting_approval";
      }
      messages = [...messages, ...toolResultMessages(await stepResults(sql, runId, steps), nowOf(deps).getTime())];
      await sql.query(`update xodo_runs set transcript = $2::jsonb, heartbeat_at = $3::timestamptz where id = $1`, [
        runId,
        json(messages),
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
  const conversation = run.conversation_id
    ? await one<{ channel: string }>(sql, `select channel from xodo_conversations where id = $1`, [run.conversation_id])
    : null;
  return buildSystemPrompt(xodo, {
    agencyName: agency?.name ?? "",
    today: dayIn(xodo.timezone, now),
    memory: await loadMemory(sql, xodo.agency_id, xodo.id),
    clients: await clientsInScope(sql, xodo),
    routine: routine ? { name: routine.name, lastSummary: routine.last_summary } : undefined,
    channel: conversation?.channel as PromptContext["channel"],
    event: run.trigger === "event",
  });
}

// ---------------------------------------------------------------------------
// Ferramentas e pedidos de aprovação
// ---------------------------------------------------------------------------

/** Registra todas as chamadas do passo, roda as liberadas e devolve as que esperam aprovação. */
async function handleToolCalls(
  deps: EngineDeps,
  xodo: Xodo,
  runId: string,
  step: number,
  calls: ToolCall[],
  tools: ToolDef[],
): Promise<{ actionId: string; summary: string }[]> {
  const { sql } = deps;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const rules = await loadRules(sql, xodo.agency_id, xodo.id);
  const pending: { actionId: string; summary: string }[] = [];
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
    let category = tool.category;
    if (tool.categoryFor) {
      try {
        category = await tool.categoryFor(toolContext(deps, xodo, runId), parsed.data);
      } catch (error) {
        // Sem conseguir ver o destino, fica a categoria declarada (a mais cautelosa).
        console.warn("[xodós] categoria dinâmica falhou", tool.name, error instanceof Error ? error.message : error);
      }
    }
    const decision = decideApproval({ toolName: tool.name, category, rules, autonomy: xodo.autonomy });
    let reason: string | null = decision.decision === "ask" ? decision.source : null;
    if (!reason && tool.mustAsk) {
      try {
        const limit = await tool.mustAsk(toolContext(deps, xodo, runId), parsed.data);
        if (limit) reason = `limite: ${limit}`;
      } catch (error) {
        const expected = error instanceof ToolError || error instanceof IntegrationError;
        if (!expected) throw error;
        await insertAction(sql, base, category, parsed.data, "failed", { error: (error as Error).message });
        continue;
      }
    }
    if (reason) {
      const actionId = await insertAction(sql, base, category, parsed.data, "pending", null, {
        reason,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      });
      const why = reason.startsWith("limite: ") ? ` (${reason.slice(8)})` : "";
      pending.push({ actionId, summary: tool.summarize(parsed.data) + why });
      continue;
    }
    const actionId = await insertAction(sql, base, category, parsed.data, "executing", null);
    await runAction(deps, xodo, actionId, tools);
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

function toolContext(deps: EngineDeps, xodo: Xodo, runId: string): ToolContext {
  const integrations = integrationDeps(deps);
  return { sql: deps.sql, xodo, runId, now: nowOf(deps), apps: integrations ? appAccess(integrations, xodo) : null };
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
export async function runAction(deps: EngineDeps, xodo: Xodo, actionId: string, known?: ToolDef[]) {
  const { sql } = deps;
  const action = await one<{ tool_name: string; input: unknown; input_hash: string; run_id: string; status: string }>(
    sql,
    `select tool_name, input, input_hash, run_id, status from xodo_actions where id = $1 and agency_id = $2`,
    [actionId, xodo.agency_id],
  );
  if (!action || action.status !== "executing") throw new XodoError("Ação não está pronta para executar", 409);
  const input = parseJson<unknown>(action.input);
  // Ferramenta de app pode ter sido desligada entre o pedido e a aprovação: aí não roda.
  const tool =
    TOOLS_BY_NAME.get(action.tool_name) ?? (known ?? (await toolsFor(deps, xodo))).find((t) => t.name === action.tool_name);

  let status: "executed" | "failed" = "failed";
  let result: unknown;
  if (!tool) {
    result = { error: "Ferramenta não existe mais." };
  } else if (inputHash(input) !== action.input_hash) {
    result = { error: "O pedido guardado foi alterado depois de criado; nada foi executado." };
  } else {
    try {
      const data = await tool.execute(toolContext(deps, xodo, action.run_id), tool.input.parse(input));
      status = "executed";
      result = { data };
    } catch (error) {
      const expected = error instanceof ToolError || error instanceof IntegrationError;
      if (!expected) console.error("[xodos] erro na ferramenta", action.tool_name, error);
      result = { error: expected ? (error as Error).message : "Erro interno ao executar a ferramenta." };
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
  const messages = [
    ...parseJson<Message[]>(claimed.transcript),
    ...toolResultMessages(await stepResults(sql, runId, claimed.steps), nowOf(deps).getTime()),
  ];
  await sql.query(`update xodo_runs set transcript = $2::jsonb where id = $1`, [runId, json(messages)]);
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

/**
 * Grava uma mensagem na conversa da execução. Se a conversa é de um canal, o que o xodó
 * escreve também entra na fila de entrega (channel_outbox), com os pedidos de aprovação.
 */
export async function addMessage(
  sql: Sql,
  xodo: Pick<Xodo, "id" | "agency_id">,
  runId: string | null,
  role: "user" | "assistant" | "note",
  text: string,
  authorUser: string | null,
  extra: { authorLabel?: string | null; approvals?: { actionId: string; summary: string }[] } = {},
) {
  await sql.query(
    `with m as (
       insert into xodo_messages (xodo_id, agency_id, run_id, role, author_user, text, author_label, conversation_id)
       values ($1, $2, $3, $4, $5, $6, $7, (select conversation_id from xodo_runs where id = $3))
       returning id, agency_id, conversation_id, role, text
     ), touched as (
       update xodo_conversations set last_message_at = now() where id = (select conversation_id from m)
     )
     insert into channel_outbox (agency_id, conversation_id, message_id, text, approvals)
     select agency_id, conversation_id, id, text, $8::jsonb from m where conversation_id is not null and role <> 'user'`,
    [xodo.id, xodo.agency_id, runId, role, authorUser, text, extra.authorLabel ?? null,
      json((extra.approvals ?? []).map((a) => ({ action_id: a.actionId, summary: a.summary })))],
  );
}

const STRICTNESS: Autonomy[] = ["age_sozinho", "pergunta_no_que_importa", "sempre_pergunta"];

/**
 * Execução disparada por gatilho segue no máximo a autonomia do gatilho: o conteúdo vem de
 * fora, então por padrão envio, exclusão, pagamento e campanha sempre perguntam.
 */
async function effectiveXodo(sql: Sql, run: RunRow, xodo: Xodo): Promise<Xodo> {
  if (run.trigger !== "event") return xodo;
  const trigger = run.event_trigger_id
    ? await one<{ autonomy_cap: Autonomy }>(sql, `select autonomy_cap from event_triggers where id = $1`, [run.event_trigger_id])
    : null;
  // Gatilho apagado no meio do caminho: na dúvida, a mais cautelosa.
  const cap = trigger?.autonomy_cap ?? "sempre_pergunta";
  const autonomy = STRICTNESS.indexOf(cap) > STRICTNESS.indexOf(xodo.autonomy) ? cap : xodo.autonomy;
  return { ...xodo, autonomy };
}
