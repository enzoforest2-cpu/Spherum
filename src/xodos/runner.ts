import { createHash } from "node:crypto";
import { Type, type AssistantMessage, type Message, type Tool, type ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { appAccess } from "../integrations/access";
import { IntegrationError } from "../integrations/http";
import { appToolsFor } from "../integrations/registry";
import type { IntegrationDeps } from "../integrations/store";
import type { ComputerDeps } from "../computer/lifecycle";
import { callWithFallback, loadCandidates, prepare, type BrainDeps, CALL_TIMEOUT_MS } from "./brain";
import { dayIn, notify } from "./budget";
import { json, num, one, parseJson, type Sql } from "./db";
import { usdBrl } from "./fx";
import { providerErrorMessage } from "./llm";
import { enqueueCapture } from "./memory/capture";
import { memoryPrompt, recallFor } from "./memory/recall";
import { partBlocked } from "../computer/gateway";
import { COMPUTER_TOOLS } from "../computer/tools";
import { MEMORY_TOOLS } from "./memory/tools";
import { redactDeep } from "./redact";
import { buildSystemPrompt, type PromptContext } from "./persona";
import { XodoError } from "./errors";
import { decideApproval, loadRules } from "./policy";
import { TOOLS, TOOLS_BY_NAME, ToolError, toolJsonSchema, type ToolContext, type ToolDef } from "./tools";
import type { Autonomy, RunStatus, ToolCall, ToolResult, Xodo } from "./types";
import { assertAgencyActive, requireFeature, xodoBlocked } from "../local/gates";

/**
 * O executor dos Xodós: um laço de passos com o modelo, no estilo do Rakazo e do OpenDots.
 *
 * Cada passo chama o cérebro do xodó (modelo principal ou um reserva), registra o gasto e
 * trata as ferramentas pedidas. O que pode rodar direto roda; o que precisa de aprovação
 * vira um pedido guardado em xodo_actions e a execução para em waiting_approval. Quando a
 * equipe decide, o servidor executa exatamente o input guardado, uma vez só, e retoma.
 */

export const MAX_STEPS = 12;
/** Com o computador, uma tarefa costuma ter mais passos (abrir, ler, clicar, conferir). */
export const MAX_STEPS_COMPUTER = 40;
/**
 * Fatia padrão de uma execução: a função da Vercel corta em 300 s e um passo (modelo + ferramenta)
 * pode levar alguns minutos, então nenhum passo começa depois disto. A próxima fatia vem por
 * deps.chainSlice (produção) ou pelo cron.
 */
export const SLICE_MS = 120_000;
/** Quanto um passo reserva antes do prazo da fatia (chamada ao modelo mais ferramentas). */
export const STEP_RESERVE_MS = 30_000;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Uma execução "running" parada há mais que isso é tratada como travada. */
export const STALE_RUN_MS = 10 * 60 * 1000;
const TRANSCRIPT_MESSAGES = 20;
const TOOL_RESULT_MAX_CHARS = 20_000;

export type EngineDeps = BrainDeps & {
  now?: () => Date;
  /** Conexões com apps (chave do cofre, fetch, endereço do Spherum). Sem isto, só as ferramentas internas. */
  integrations?: Omit<IntegrationDeps, "sql" | "now">;
  /** Computador na nuvem (provedores e chave do cofre). Sem isto, as ferramentas do computador recusam. */
  computer?: Omit<ComputerDeps, "sql" | "now">;
  /** Pede a próxima fatia de uma execução que parou no prazo (em produção, uma chamada à própria API). */
  chainSlice?: (runId: string) => Promise<void>;
};

function integrationDeps(deps: EngineDeps): IntegrationDeps | null {
  return deps.integrations ? { ...deps.integrations, sql: deps.sql, now: deps.now } : null;
}

export { XodoError };

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

/** Notas de retomada depois de a pessoa usar o computador (adaptadas do Rakazo, Apache-2.0). */
export const TAKEOVER_NOTES = {
  done: "A pessoa terminou o que você pediu no computador. Continue de onde parou e não peça o controle de novo.",
  skipped: "A pessoa não fez o que você pediu no computador. Continue sem contar com isso; só peça o controle de novo se não houver outro caminho.",
  expired: "Ninguém assumiu o computador a tempo. Continue sem contar com isso; só peça o controle de novo se não houver outro caminho.",
} as const;

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
  return [...TOOLS, ...MEMORY_TOOLS, ...computerTools(xodo)].filter((t) => !disabled.has(t.name) && (xodo.memory_enabled || !t.memory));
}

/** Ferramentas do computador na nuvem: só para xodós com ele ligado (cada uma confere a sua parte). */
const computerTools = (xodo: Xodo) => COMPUTER_TOOLS.filter((t) => t.computerPart && !partBlocked(xodo, t.computerPart));

/** Tudo que o xodó pode usar: ferramentas internas e as dos apps liberados para ele. */
export async function toolsFor(deps: EngineDeps, xodo: Xodo): Promise<ToolDef[]> {
  const disabled = await disabledTools(deps.sql, xodo);
  const apps = await appToolsFor(integrationDeps(deps), xodo);
  return [...TOOLS, ...MEMORY_TOOLS, ...computerTools(xodo), ...apps].filter(
    (t) => !disabled.has(t.name) && (xodo.memory_enabled || !t.memory),
  );
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
  // Agência suspensa ou xodós desligados pela equipe do Spherum: nada começa (vale também para rotinas e canais).
  await assertAgencyActive(sql, input.agencyId);
  await requireFeature(sql, "xodo");
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
  // Confere e cria na mesma transação, com a conversa travada: dois pedidos ao mesmo tempo não viram duas execuções.
  const run = await sql.transaction(async (tx) => {
    if (spoken) {
      await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`xodo-conversa:${xodo.id}:${conversationId ?? "app"}`]);
      // Um pedido por vez em cada conversa (a do app ou a de um canal). Rotinas e gatilhos rodam à parte. A janela é a
      // mesma que a faxina usa para dar uma execução como parada (3 × STALE_RUN_MS).
      const busy = await one(
        tx,
        `select 1 from xodo_runs where xodo_id = $1 and status = 'running' and heartbeat_at > $2::timestamptz
            and trigger in ('user', 'channel') and ${conversationId ? "conversation_id = $3::uuid" : "conversation_id is null"}`,
        conversationId
          ? [xodo.id, new Date(now.getTime() - 3 * STALE_RUN_MS).toISOString(), conversationId]
          : [xodo.id, new Date(now.getTime() - 3 * STALE_RUN_MS).toISOString()],
      );
      if (busy) throw new XodoError(`${xodo.name} ainda está trabalhando no pedido anterior.`, 409);
    }
    return one<{ id: string }>(
      tx,
      `insert into xodo_runs (xodo_id, agency_id, trigger, routine_id, requested_by, provider, model, started_at, heartbeat_at,
         conversation_id, event_trigger_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, $9, $10) returning id`,
      [xodo.id, xodo.agency_id, input.trigger, input.routineId ?? null, input.userId ?? null, xodo.provider, xodo.model, now.toISOString(),
        conversationId, input.eventTriggerId ?? null],
    );
  });
  const runId = run!.id;

  if (spoken) await addMessage(sql, xodo, runId, "user", text, input.userId ?? null, { authorLabel: input.authorLabel ?? null });

  // Gatilho começa do zero: o evento vem de fora e não deve se misturar com a conversa.
  const recent =
    input.trigger === "event"
      ? []
      : await sql.query<{ role: "user" | "assistant"; text: string }>(
          // Filtros separados para cada caso usar o próprio índice (conversa do app ou do canal).
          `select role, text from (
             select id, role, text from xodo_messages
              where xodo_id = $1 and agency_id = $2 and role in ('user', 'assistant')
                and ${conversationId ? "conversation_id = $4::uuid" : "conversation_id is null"}
              order by id desc limit $3
           ) m order by id`,
          conversationId ? [xodo.id, xodo.agency_id, TRANSCRIPT_MESSAGES, conversationId] : [xodo.id, xodo.agency_id, TRANSCRIPT_MESSAGES],
        );
  const turns = recent.map((m) => ({ role: m.role, text: m.text }));
  if (!spoken) turns.push({ role: "user", text });
  // Lembranças da memória para esta mensagem: só no transcript (não aparecem na conversa).
  if (xodo.memory_enabled && turns.length) {
    const recall = await recallFor(sql, xodo, text, { trigger: input.trigger, now: nowOf(deps) });
    const last = turns[turns.length - 1];
    if (recall && last.role === "user") last.text = `${recall}\n\n${last.text}`;
  }

  await sql.query(`update xodo_runs set transcript = $2::jsonb where id = $1`, [runId, json(historyMessages(turns))]);
  return runId;
}

// ---------------------------------------------------------------------------
// O laço
// ---------------------------------------------------------------------------

/**
 * Roda a execução até terminar, pedir aprovação ou esperar a pessoa. Com deadline (ms do relógio
 * do servidor), para antes de começar um passo depois dele e marca a fatia para continuar
 * (a função da Vercel tem tempo máximo); quem chamou encadeia a próxima fatia.
 */
export async function continueRun(deps: EngineDeps, runId: string, opts: { deadline?: number } = {}): Promise<RunStatus> {
  const { sql } = deps;
  const deadline = opts.deadline ?? Date.now() + SLICE_MS;
  const run = await loadRun(sql, runId);
  if (run.status !== "running") return run.status;
  const cap = await eventCap(sql, run);
  const loaded = await loadXodo(sql, run.xodo_id, run.agency_id);
  // Pausado no meio: a execução para aqui, sem mais chamadas ao modelo nem ações.
  if (loaded.status !== "active") return finish(deps, loaded, runId, "failed", { note: `${loaded.name} foi pausado pela equipe; parei por aqui.` });
  // Agência suspensa ou xodós desligados pelo Spherum: também para aqui (vale para retomadas e o cron).
  const blocked = await xodoBlocked(sql, run.agency_id);
  if (blocked) return finish(deps, loaded, runId, "failed", { note: blocked });
  const xodo = cap && STRICTNESS.indexOf(cap) > STRICTNESS.indexOf(loaded.autonomy) ? { ...loaded, autonomy: cap } : loaded;

  try {
    const tools = await toolsFor(deps, xodo);
    const systemPrompt = await systemPromptFor(sql, xodo, run, nowOf(deps), tools.some((t) => ADS_TOOLS.has(t.name)));
    const candidates = await loadCandidates(sql, xodo, run.trigger);
    let messages = parseJson<Message[]>(run.transcript);
    let steps = run.steps;
    // Começa pelo modelo principal; se um reserva assumir, segue com ele até o fim da execução.
    let active = 0;

    const maxSteps = xodo.computer_mode === "cloud" ? MAX_STEPS_COMPUTER : MAX_STEPS;
    while (true) {
      // Um passo precisa de tempo para a chamada ao modelo e para as ferramentas: perto do prazo, nem começa.
      if (Date.now() > deadline - STEP_RESERVE_MS) {
        await sql.query(`update xodo_runs set slice_due_at = $2::timestamptz, heartbeat_at = $2::timestamptz where id = $1`, [
          runId,
          nowOf(deps).toISOString(),
        ]);
        // Sem a chamada encadeada (ou se ela falhar), o cron continua depois de 1 minuto.
        await deps.chainSlice?.(runId).catch((error) => console.error("[xodos] fatia não encadeada", runId, error));
        return "running";
      }
      if (steps >= maxSteps) {
        return finish(deps, xodo, runId, "completed", {
          text: "Parei aqui porque cheguei no limite de passos desta tarefa. Me diga se devo continuar.",
        });
      }

      const day = dayIn(xodo.timezone, nowOf(deps));
      const rate = await usdBrl(sql, day);
      if (xodo.daily_budget_brl !== null && rate === null) {
        return finish(deps, xodo, runId, "failed", {
          error: "Ainda não há cotação do dólar para garantir o teto em reais. Tente de novo em alguns minutos.",
        });
      }

      const result = await callWithFallback(deps, {
        xodo,
        runId,
        step: steps + 1,
        day,
        usdBrl: rate,
        // A chamada não pode passar do prazo da fatia (a função da Vercel morreria com o passo pela metade).
        timeoutMs: Math.max(20_000, Math.min(CALL_TIMEOUT_MS, deadline - Date.now() - 10_000)),
        context: { systemPrompt, messages, tools: piTools(tools) },
        candidates,
        startAt: active,
      });
      if (!result.ok && result.reason === "budget") {
        const cap = num(result.cap).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
        return finish(deps, xodo, runId, "paused_budget", {
          note: `Pausei: o teto de hoje (${cap}) não comporta o próximo passo. Volto amanhã ou quando o teto for aumentado.`,
        });
      }
      if (!result.ok && result.reason === "refused") {
        return finish(deps, xodo, runId, "refused", { text: "Não posso ajudar com esse pedido." });
      }
      if (!result.ok) {
        const reason = result.detail ? providerErrorMessage(result.detail) : `nenhum modelo pôde ser usado (${result.problems.join("; ")})`;
        return finish(deps, xodo, runId, "failed", { error: reason });
      }

      active = result.index;
      // Dados sensíveis passados a ferramentas que limpam a entrada também saem do transcript.
      const message = scrubToolCalls(result.message, tools);
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
        return finish(deps, xodo, runId, "completed", { text: (text || "(sem resposta)") + cut });
      }

      if (text) await addMessage(sql, xodo, runId, "assistant", text, null);

      // Depois de ler conteúdo de fora (página, arquivo baixado), segue mais cautelosa até o fim.
      const tainted = (await one<{ tainted: boolean }>(sql, `select tainted from xodo_runs where id = $1`, [runId]))?.tainted;
      const stepCap = stricter(cap, tainted ? "pergunta_no_que_importa" : null);
      const stepXodo = stepCap && STRICTNESS.indexOf(stepCap) > STRICTNESS.indexOf(xodo.autonomy) ? { ...xodo, autonomy: stepCap } : xodo;
      const pending = await handleToolCalls(deps, stepXodo, runId, steps, calls, tools, stepCap, run.trigger, !!tainted);
      if (pending.length) {
        await sql.query(`update xodo_runs set status = 'waiting_approval' where id = $1`, [runId]);
        const numbers = await numberChannelActions(sql, runId, pending.map((p) => p.actionId));
        const list =
          pending.length === 1 && !numbers.size
            ? `• ${pending[0].summary}`
            : pending.map((p, i) => `${numbers.get(p.actionId) ?? i + 1}. ${p.summary}`).join("\n");
        await addMessage(sql, xodo, runId, "note", `Preciso de aprovação para:\n${list}`, null, { approvals: pending });
        await notify(sql, xodo.agency_id, {
          kind: "approval_pending",
          title: `${xodo.name} pede aprovação`,
          body: pending.map((p) => p.summary).join("; "),
          data: { xodo_id: xodo.id, run_id: runId },
        });
        return "waiting_approval";
      }
      const takeover = await takeoverRequested(sql, runId, steps, tools);
      if (takeover !== null) return parkForTakeover(deps, xodo, runId, takeover);
      messages = [...messages, ...toolResultMessages(await stepResults(sql, runId, steps), nowOf(deps).getTime())];
      await sql.query(`update xodo_runs set transcript = $2::jsonb, heartbeat_at = $3::timestamptz where id = $1`, [
        runId,
        json(messages),
        nowOf(deps).toISOString(),
      ]);
    }
  } catch (error) {
    if (error instanceof XodoError) return finish(deps, xodo, runId, "failed", { error: error.message });
    await finish(deps, xodo, runId, "failed", { error: "Erro interno no motor dos Xodós." });
    throw error;
  }
}

/** Ferramentas que mexem em campanha: com elas, o prompt leva o guia de mídia paga. */
const ADS_TOOLS = new Set(["listar_campanhas", "pausar_campanha", "ativar_campanha", "ajustar_verba_diaria", "auditar_conta"]);

async function systemPromptFor(sql: Sql, xodo: Xodo, run: RunRow, now: Date, ads = false) {
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
    memory: await memoryPrompt(sql, xodo),
    clients: await clientsInScope(sql, xodo),
    routine: routine ? { name: routine.name, lastSummary: routine.last_summary } : undefined,
    channel: conversation?.channel as PromptContext["channel"],
    event: run.trigger === "event",
    ads,
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
  cap: Autonomy | null = null,
  trigger?: string,
  tainted = false,
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
      await insertAction(sql, base, tool.category, tool.scrub ? redactDeep(call.input).value : call.input, "failed", {
        error: `Entrada inválida: ${z.prettifyError(parsed.error)}`,
      });
      continue;
    }
    // O que fica guardado (e o que roda depois da aprovação) é a entrada já limpa.
    if (tool.scrub) parsed.data = tool.scrub(parsed.data);
    let category = tool.category;
    if (tool.categoryFor) {
      try {
        category = await tool.categoryFor(toolContext(deps, xodo, runId, trigger, tainted), parsed.data);
      } catch (error) {
        // Sem conseguir ver o destino, fica a categoria declarada (a mais cautelosa).
        console.warn("[xodós] categoria dinâmica falhou", tool.name, error instanceof Error ? error.message : error);
      }
    }
    const tctx = toolContext(deps, xodo, runId, trigger, tainted);
    const site = tool.siteOf ? await tool.siteOf(tctx, parsed.data).catch(() => null) : null;
    const decision = decideApproval({ toolName: tool.name, category, rules, autonomy: xodo.autonomy, cap, floor: tool.floor, site });
    let reason: string | null = decision.decision === "ask" ? decision.source : null;
    if (!reason && tool.mustAsk) {
      try {
        const limit = await tool.mustAsk(toolContext(deps, xodo, runId, trigger, tainted), parsed.data);
        if (limit) reason = `limite: ${limit}`;
      } catch (error) {
        const expected = error instanceof ToolError || error instanceof IntegrationError || error instanceof XodoError;
        if (!expected) throw error;
        await insertAction(sql, base, category, parsed.data, "failed", { error: (error as Error).message });
        continue;
      }
    }
    if (reason) {
      let precondition: Record<string, unknown> | null = null;
      try {
        precondition = tool.precondition ? await tool.precondition(tctx, parsed.data) : null;
      } catch (error) {
        const expected = error instanceof ToolError || error instanceof IntegrationError || error instanceof XodoError;
        if (!expected) throw error;
        await insertAction(sql, base, category, parsed.data, "failed", { error: (error as Error).message });
        continue;
      }
      if (site) precondition = { ...(precondition ?? {}), site };
      const actionId = await insertAction(sql, base, category, parsed.data, "pending", null, {
        reason,
        expiresAt: new Date(now.getTime() + (tool.approvalTtlMs ?? APPROVAL_TTL_MS)),
        precondition,
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
  extra: { reason?: string; expiresAt?: Date; precondition?: Record<string, unknown> | null } = {},
): Promise<string> {
  const row = await one<{ id: string }>(
    sql,
    `insert into xodo_actions (run_id, xodo_id, agency_id, tool_name, tool_call_id, step, call_index,
       category, input, input_hash, status, result, reason, expires_at, precondition)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14::timestamptz, $15::jsonb)
     on conflict (run_id, tool_call_id) do nothing
     returning id`,
    [...base, category, json(input), inputHash(input), status, result === null ? null : json(result),
      extra.reason ?? null, extra.expiresAt?.toISOString() ?? null, extra.precondition ? json(extra.precondition) : null],
  );
  if (!row) throw new XodoError("O modelo repetiu o id de uma chamada de ferramenta.", 502);
  return row.id;
}

function toolContext(deps: EngineDeps, xodo: Xodo, runId: string, trigger?: string, tainted = false): ToolContext {
  const integrations = integrationDeps(deps);
  return {
    sql: deps.sql,
    xodo,
    runId,
    now: nowOf(deps),
    trigger,
    tainted,
    apps: integrations ? appAccess(integrations, xodo) : null,
    computer: deps.computer ? { ...deps.computer, sql: deps.sql, now: deps.now } : null,
  };
}

/** Passa os argumentos das chamadas pelo scrub da ferramenta (o transcript guarda a versão limpa). */
function scrubToolCalls(message: AssistantMessage, tools: ToolDef[]): AssistantMessage {
  const byName = new Map(tools.map((t) => [t.name, t]));
  if (!message.content.some((b) => b.type === "toolCall" && byName.get(b.name)?.scrub)) return message;
  return {
    ...message,
    content: message.content.map((b) =>
      b.type === "toolCall" && byName.get(b.name)?.scrub ? { ...b, arguments: redactDeep(b.arguments).value } : b,
    ),
  };
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
  const action = await one<{ tool_name: string; input: unknown; input_hash: string; run_id: string; status: string; precondition: unknown }>(
    sql,
    `select tool_name, input, input_hash, run_id, status, precondition from xodo_actions where id = $1 and agency_id = $2`,
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
      const ctx = { ...toolContext(deps, xodo, action.run_id), precondition: parseJson<Record<string, unknown>>(action.precondition) };
      const parsedInput = tool.input.parse(input);
      const data = await tool.execute(ctx, parsedInput);
      status = "executed";
      result = { data };
      if (tool.taints) await sql.query(`update xodo_runs set tainted = true where id = $1`, [action.run_id]);
    } catch (error) {
      const expected = error instanceof ToolError || error instanceof IntegrationError || error instanceof XodoError;
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
export async function resumeRun(deps: EngineDeps, runId: string, opts: { deadline?: number } = {}): Promise<RunStatus | null> {
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
  // O pedido de controle aprovado (ou junto de outro pedido) também espera a pessoa. Os
  // resultados do passo entram na conversa na retomada (resumeTakeover), não aqui.
  const takeover = await takeoverRequested(sql, runId, claimed.steps, [...COMPUTER_TOOLS]);
  if (takeover !== null) return parkForTakeover(deps, await loadXodo(sql, claimed.xodo_id, claimed.agency_id), runId, takeover);
  const messages = [
    ...parseJson<Message[]>(claimed.transcript),
    ...toolResultMessages(await stepResults(sql, runId, claimed.steps), nowOf(deps).getTime()),
  ];
  await sql.query(`update xodo_runs set transcript = $2::jsonb where id = $1`, [runId, json(messages)]);
  return continueRun(deps, runId, opts);
}

// ---------------------------------------------------------------------------
// Fim
// ---------------------------------------------------------------------------

async function finish(
  deps: EngineDeps,
  xodo: Xodo,
  runId: string,
  status: RunStatus,
  out: { text?: string; note?: string; error?: string },
): Promise<RunStatus> {
  const { sql } = deps;
  await sql.query(
    `update xodo_runs set status = $2, final_text = coalesce($3, final_text), error = $4, finished_at = now() where id = $1`,
    [runId, status, out.text ?? out.note ?? null, out.error ?? null],
  );
  // Execução encerrada não deixa pedido de aprovação pendurado (ele rodaria sem a execução para receber o resultado).
  if (status === "failed" || status === "completed") {
    await sql.query(`update xodo_actions set status = 'expired' where run_id = $1 and status = 'pending'`, [runId]);
  }
  // Rotina com continuidade guarda o resumo do que saiu, inclusive quando a execução terminou numa fatia do cron.
  if (status === "completed" && out.text) {
    await sql.query(
      `update xodo_routines set last_summary = left($2, 2000) where continuity and id = (select routine_id from xodo_runs where id = $1 and routine_id is not null)`,
      [runId, out.text],
    );
  }
  if (out.text) await addMessage(sql, xodo, runId, "assistant", out.text, null);
  if (out.note) await addMessage(sql, xodo, runId, "note", out.note, null);
  if (out.error) await addMessage(sql, xodo, runId, "note", `Não consegui terminar: ${out.error}`, null);
  if (status === "completed") {
    // A captura da memória roda depois, fora da execução; falha aqui não muda o resultado.
    const run = await one<{ id: string; xodo_id: string; agency_id: string; trigger: string; status: string; conversation_id: string | null }>(
      sql,
      `select id, xodo_id, agency_id, trigger, status, conversation_id from xodo_runs where id = $1`,
      [runId],
    );
    if (run) await enqueueCapture(sql, run, nowOf(deps)).catch((error) => console.warn("[memória] captura não agendada", runId, error));
  }
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
    // O que um gatilho produz aparece no app como nota: fica visível, mas não entra no histórico
    // do xodó como fala dele (o conteúdo veio de fora).
    `with m as (
       insert into xodo_messages (xodo_id, agency_id, run_id, role, author_user, text, author_label, conversation_id)
       values ($1, $2, $3,
               case when $4 = 'assistant' and (select trigger from xodo_runs where id = $3) = 'event' then 'note' else $4 end,
               $5, $6, $7, (select conversation_id from xodo_runs where id = $3))
       returning id, agency_id, conversation_id, role, text
     ), touched as (
       update xodo_conversations set last_message_at = now() where id = (select conversation_id from m)
     )
     -- Pronta para entrega desde a última batida da execução (o relógio do motor), nunca no futuro.
     insert into channel_outbox (agency_id, conversation_id, message_id, text, approvals, next_attempt_at)
     select agency_id, conversation_id, id, text, $8::jsonb,
            least(now(), coalesce((select heartbeat_at from xodo_runs where id = $3), now()))
       from m where conversation_id is not null and role <> 'user'`,
    [xodo.id, xodo.agency_id, runId, role, authorUser, text, extra.authorLabel ?? null,
      json((extra.approvals ?? []).map((a) => ({ action_id: a.actionId, summary: a.summary })))],
  );
}

/**
 * Dá aos pedidos de uma conversa de canal o próximo número fixo daquela thread ("aprovar 3").
 * Fora de canal, não faz nada. A trava por thread evita dois pedidos com o mesmo número.
 */
async function numberChannelActions(sql: Sql, runId: string, actionIds: string[]): Promise<Map<string, number>> {
  const thread = await one<{ connection_id: string; external_key: string }>(
    sql,
    `select c.connection_id, c.external_key from xodo_runs r join xodo_conversations c on c.id = r.conversation_id
      where r.id = $1 and c.connection_id is not null`,
    [runId],
  );
  if (!thread || !actionIds.length) return new Map();
  const rows = await sql.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`canal:${thread.connection_id}:${thread.external_key}`]);
    return tx.query<{ id: string; channel_seq: number }>(
      `with base as (
         select coalesce(max(a.channel_seq), 0) as m from xodo_actions a
           join xodo_runs r on r.id = a.run_id
           join xodo_conversations c on c.id = r.conversation_id
          where c.connection_id = $2 and c.external_key = $3)
       update xodo_actions a set channel_seq = base.m + x.ord
         from base, unnest($1::uuid[]) with ordinality as x(id, ord)
        where a.id = x.id
       returning a.id, a.channel_seq`,
      [actionIds, thread.connection_id, thread.external_key],
    );
  });
  return new Map(rows.map((r) => [r.id, Number(r.channel_seq)]));
}

const STRICTNESS: Autonomy[] = ["age_sozinho", "pergunta_no_que_importa", "sempre_pergunta"];

/** A mais cautelosa de duas autonomias (nulo: sem limite). */
function stricter(a: Autonomy | null, b: Autonomy | null): Autonomy | null {
  if (!a) return b;
  if (!b) return a;
  return STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b;
}

/** Motivo do pedido de controle, se uma ferramenta do passo encerrou o turno esperando a pessoa. */
/** Para a execução até a pessoa assumir o computador e avisa a equipe. */
async function parkForTakeover(deps: EngineDeps, xodo: Xodo, runId: string, motivo: string): Promise<RunStatus> {
  const { sql } = deps;
  await sql.query(`update xodo_runs set status = 'waiting_takeover', heartbeat_at = $2::timestamptz where id = $1`, [
    runId,
    nowOf(deps).toISOString(),
  ]);
  await addMessage(sql, xodo, runId, "note", `Preciso de você no computador: ${motivo}`, null);
  await notify(sql, xodo.agency_id, {
    kind: "takeover_requested",
    title: `${xodo.name} precisa de você no computador`,
    body: motivo,
    data: { xodo_id: xodo.id, run_id: runId },
  });
  return "waiting_takeover";
}

async function takeoverRequested(sql: Sql, runId: string, step: number, tools: ToolDef[]): Promise<string | null> {
  const names = tools.filter((t) => t.endsTurn === "takeover").map((t) => t.name);
  if (!names.length) return null;
  const row = await one<{ result: unknown }>(
    sql,
    `select result from xodo_actions where run_id = $1 and step = $2 and status = 'executed' and tool_name = any($3::text[]) limit 1`,
    [runId, step, names],
  );
  if (!row) return null;
  const data = parseJson<{ data?: { motivo?: unknown } }>(row.result)?.data;
  return typeof data?.motivo === "string" && data.motivo ? data.motivo : "preciso que você faça uma parte no computador.";
}

/**
 * A pessoa devolveu o controle do computador (ou não assumiu a tempo): o xodó continua de onde
 * parou, com uma nota dizendo o que aconteceu.
 */
export async function resumeTakeover(
  deps: EngineDeps,
  runId: string,
  outcome: keyof typeof TAKEOVER_NOTES,
  message?: { text: string; userId: string },
  opts: { deadline?: number } = {},
): Promise<RunStatus | null> {
  const { sql } = deps;
  const claimed = await one<RunRow>(
    sql,
    `update xodo_runs set status = 'running', heartbeat_at = $2::timestamptz, resume_note = $3
      where id = $1 and status = 'waiting_takeover' returning *`,
    [runId, nowOf(deps).toISOString(), outcome],
  );
  if (!claimed) return null;
  const at = nowOf(deps).getTime();
  // A mensagem que a pessoa mandou no chat enquanto o xodó esperava vai junto com a nota.
  if (message) await addMessage(sql, { id: claimed.xodo_id, agency_id: claimed.agency_id }, runId, "user", message.text, message.userId);
  const note = `[nota do Spherum] ${TAKEOVER_NOTES[outcome]}`;
  const messages: Message[] = [
    ...parseJson<Message[]>(claimed.transcript),
    ...toolResultMessages(await stepResults(sql, runId, claimed.steps), at),
    { role: "user", content: message ? `${note}\n\nMensagem da pessoa: ${message.text}` : note, timestamp: at },
  ];
  await sql.query(`update xodo_runs set transcript = $2::jsonb where id = $1`, [runId, json(messages)]);
  return continueRun(deps, runId, opts);
}

/** Continua uma execução fatiada (uma chamada por fatia: a primeira que pegar leva). */
export async function continueSlice(deps: EngineDeps, runId: string, opts: { deadline?: number } = {}): Promise<RunStatus | null> {
  const claimed = await one(
    deps.sql,
    `update xodo_runs set slice_due_at = null where id = $1 and status = 'running' and slice_due_at is not null returning id`,
    [runId],
  );
  if (!claimed) return null;
  return continueRun(deps, runId, opts);
}

/**
 * Teto de autonomia de uma execução por gatilho: o conteúdo vem de fora, então por padrão
 * envio, exclusão, pagamento e campanha sempre perguntam, mesmo com "sempre permitir".
 * Nulo para as outras execuções.
 */
async function eventCap(sql: Sql, run: RunRow): Promise<Autonomy | null> {
  if (run.trigger !== "event") return null;
  const trigger = run.event_trigger_id
    ? await one<{ autonomy_cap: Autonomy }>(sql, `select autonomy_cap from event_triggers where id = $1`, [run.event_trigger_id])
    : null;
  // Gatilho apagado no meio do caminho: na dúvida, a mais cautelosa.
  return trigger?.autonomy_cap ?? "sempre_pergunta";
}
