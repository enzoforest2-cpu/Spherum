import { access } from "../integrations/store";
import { decideAction } from "../xodos/actions";
import { dayIn } from "../xodos/budget";
import { one, parseJson, type Sql } from "../xodos/db";
import { continueRun, resumeRun, startRun, XodoError } from "../xodos/runner";
import { flushOutbox, threadActions } from "./outbox";
import { extractPairingCode, identityFor, linkIdentity, redeemPairingCode } from "./pairing";
import {
  CHANNEL_LABEL,
  CHANNEL_OF,
  integrationDepsOf,
  type Adapters,
  type ChannelDeps,
  type ChannelProvider,
  type InboundMessage,
  type InboundResult,
} from "./types";

/**
 * O caminho de uma mensagem que chega por um canal até a resposta:
 *
 *  1. descarta repetição (as plataformas reenviam);
 *  2. descobre quem é (conta vinculada a alguém da equipe) ou tenta o código de pareamento;
 *  3. "aprovar"/"negar" decide um pedido pendente daquela conversa;
 *  4. escolhe o xodó do canal, abre (ou continua) a conversa e roda o pedido;
 *  5. entrega o que o xodó escreveu pela fila (channel_outbox).
 *
 * Quem não está vinculado não conversa com o xodó. Em mensagem direta, recebe uma vez por dia
 * a explicação de como se vincular; em canal com várias pessoas, silêncio.
 */

/** Grava o evento; devolve true se ele já tinha chegado antes. */
export async function seenBefore(sql: Sql, source: string, eventId: string): Promise<boolean> {
  const row = await one(
    sql,
    `insert into channel_events (source, event_id) values ($1, $2) on conflict do nothing returning event_id`,
    [source.slice(0, 200), eventId.slice(0, 200)],
  );
  return !row;
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * Xodó que atende a mensagem: se o texto chama um xodó pelo nome, é ele; senão, o do canal
 * (no Slack) e por último o do workspace ou número todo.
 */
export async function routeXodo(sql: Sql, connectionId: string, scope: string | undefined, text: string) {
  const rows = await sql.query<{ id: string; name: string; scope: string }>(
    `select x.id, x.name, c.scope from xodo_channels c join xodos x on x.id = c.xodo_id
      where c.connection_id = $1 and c.enabled and x.status = 'active' and c.scope in ($2, '*')
      order by (c.scope = '*'), c.created_at`,
    [connectionId, scope ?? "*"],
  );
  if (!rows.length) return null;
  const said = normalize(text);
  const named = rows.find((r) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(normalize(r.name))}([^\\p{L}\\p{N}]|$)`, "u").test(said));
  return named ?? rows[0];
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "aprovar", "sim", "negar 2"… Devolve a decisão e, se houver, o número do pedido. */
export function parseDecision(text: string): { approve: boolean; index: number | null } | null {
  const m = normalize(text.trim()).match(/^(aprovar|aprovado|aprova|sim|ok|negar|negado|nega|nao)(?:\s+(\d{1,2}))?[.!]?$/);
  if (!m) return null;
  return { approve: !["negar", "negado", "nega", "nao"].includes(m[1]), index: m[2] ? Number(m[2]) : null };
}

/** Resposta do sistema fora de uma conversa (confirmação de pareamento, explicações). */
export async function sendDirect(deps: ChannelDeps, adapters: Adapters, msg: InboundMessage, text: string) {
  const adapter = adapters[msg.provider];
  if (!adapter) return;
  const integrations = integrationDepsOf(deps);
  try {
    const a = await access(integrations, msg.agencyId, msg.connectionId);
    await adapter.send({ deps: integrations, access: a, target: msg.reply, xodoName: null }, { text, approvals: [] });
  } catch (error) {
    console.warn("[canais] resposta direta falhou", msg.provider, error instanceof Error ? error.message : error);
  }
}

const HINT =
  "Oi! Eu sou um xodó do Spherum e só converso com a equipe da agência. Para se vincular, gere um código no Spherum (Integrações → Canais) e me mande aqui.";

export async function receiveMessage(deps: ChannelDeps, adapters: Adapters, msg: InboundMessage): Promise<InboundResult> {
  const { sql } = deps;
  const now = deps.now ? deps.now() : new Date();
  const channel = CHANNEL_OF[msg.provider];
  if (await seenBefore(sql, `${msg.provider}:${msg.connectionId}`, msg.eventId)) return { status: "duplicate" };
  const text = msg.text.trim();
  if (!text) return { status: "ignored" };

  // Um código válido vincula (ou revincula a outra pessoa da equipe) antes de qualquer coisa.
  const code = extractPairingCode(text);
  const pairedUser = code ? await redeemPairingCode(sql, msg.agencyId, code, now) : null;
  if (pairedUser) {
    await linkIdentity(sql, { agencyId: msg.agencyId, provider: channel, externalUser: msg.externalUser, userId: pairedUser, displayName: msg.displayName });
    await sendDirect(deps, adapters, msg, "Pronto, conta vinculada! Agora é só me chamar por aqui.");
    return { status: "paired" };
  }

  const identity = await identityFor(sql, msg.agencyId, channel, msg.externalUser);
  if (!identity) {
    // Explica uma vez por dia, e só em conversa direta: em canal com várias pessoas, silêncio.
    if (msg.direct && !(await seenBefore(sql, `dica:${msg.provider}:${msg.connectionId}:${msg.externalUser}`, dayIn("UTC", now)))) {
      await sendDirect(deps, adapters, msg, HINT);
    }
    return { status: "unknown_sender" };
  }

  const decision = parseDecision(text);
  if (decision) {
    const handled = await decideByText(deps, adapters, msg, decision);
    if (handled) return handled;
  }

  const xodo = await routeXodo(sql, msg.connectionId, msg.scope, text);
  if (!xodo) {
    if (msg.direct) await sendDirect(deps, adapters, msg, "Nenhum xodó atende por este canal ainda. Escolha um no Spherum (Integrações → Canais).");
    return { status: "no_xodo" };
  }

  const conversation = await one<{ id: string }>(
    sql,
    `insert into xodo_conversations (agency_id, xodo_id, channel, connection_id, external_key, title, metadata)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (xodo_id, connection_id, external_key) do update set metadata = excluded.metadata
     returning id`,
    [msg.agencyId, xodo.id, channel, msg.connectionId, msg.conversationKey, msg.displayName ?? null, JSON.stringify(msg.reply)],
  );
  const who = identity.displayName ?? msg.displayName ?? "Alguém da equipe";
  let runId: string;
  try {
    runId = await startRun(deps, {
      xodoId: xodo.id,
      agencyId: msg.agencyId,
      trigger: "channel",
      text,
      userId: identity.userId,
      conversationId: conversation!.id,
      authorLabel: `${who} pelo ${CHANNEL_LABEL[channel]}`,
    });
  } catch (error) {
    if (!(error instanceof XodoError)) throw error;
    await sendDirect(deps, adapters, msg, error.message);
    return { status: error.status === 409 ? "busy" : "failed", detail: error.message };
  }
  try {
    await continueRun(deps, runId);
  } finally {
    await flushOutbox(deps, adapters, { conversationId: conversation!.id });
  }
  return { status: "started", runId };
}

/**
 * "aprovar", "negar 3"… pelo número fixo do pedido na conversa. Sem pedido pendente nem número
 * conhecido, não é decisão: a mensagem segue para o xodó como conversa normal.
 */
async function decideByText(
  deps: ChannelDeps,
  adapters: Adapters,
  msg: InboundMessage,
  decision: { approve: boolean; index: number | null },
): Promise<InboundResult | null> {
  const { sql } = deps;
  const pending = await threadActions(sql, msg.connectionId, msg.conversationKey, msg.agencyId, { pendingOnly: true });
  let chosen: { id: string; number: number };
  if (decision.index === null) {
    if (!pending.length) return null;
    if (pending.length > 1) {
      const numbers = pending.map((a) => a.number).join(", ");
      await sendDirect(deps, adapters, msg, `Há ${pending.length} pedidos esperando (${numbers}). Diga qual: "aprovar ${pending[0].number}", "negar ${pending[1].number}"…`);
      return { status: "decided", detail: "ambíguo" };
    }
    chosen = pending[0];
  } else {
    const all = await threadActions(sql, msg.connectionId, msg.conversationKey, msg.agencyId);
    const target = all.find((a) => a.number === decision.index);
    if (!target) {
      if (!pending.length) return null;
      await sendDirect(deps, adapters, msg, `Não achei o pedido ${decision.index}. Esperando: ${pending.map((a) => a.number).join(", ")}.`);
      return { status: "decided", detail: "número inválido" };
    }
    if (target.status !== "pending") {
      // Nunca escolhe outro pedido no lugar: o número é o que a pessoa viu.
      await sendDirect(deps, adapters, msg, `O pedido ${target.number} já foi ${target.status === "expired" ? "encerrado (expirou)" : "decidido"}.`);
      return { status: "decided", detail: "já decidido" };
    }
    chosen = target;
  }
  const outcome = await decideFromChannel(deps, adapters, {
    provider: msg.provider,
    agencyId: msg.agencyId,
    externalUser: msg.externalUser,
    actionId: chosen.id,
    approve: decision.approve,
  });
  if (!outcome.ok) {
    await sendDirect(deps, adapters, msg, outcome.message);
  } else if (!outcome.resumed) {
    // O xodó só continua quando todos os pedidos do passo forem decididos: confirma e diz o que falta.
    const left = await threadActions(sql, msg.connectionId, msg.conversationKey, msg.agencyId, { pendingOnly: true });
    const rest = left.length ? ` Ainda esperando: ${left.map((a) => a.number).join(", ")}.` : "";
    await sendDirect(deps, adapters, msg, `Pedido ${chosen.number}: ${outcome.message}${rest}`);
  }
  return { status: "decided", detail: outcome.message };
}

export type ChannelDecision = {
  provider: ChannelProvider;
  agencyId: string;
  externalUser: string;
  actionId: string;
  approve: boolean;
};

/**
 * Decisão vinda de um botão ou de "aprovar"/"negar" no canal. Só vale para conta vinculada a
 * alguém da equipe que pode aprovar no app (owner, admin ou member).
 */
export async function decideFromChannel(
  deps: ChannelDeps,
  adapters: Adapters,
  input: ChannelDecision,
): Promise<{ ok: boolean; message: string; runId?: string; resumed?: boolean }> {
  const channel = CHANNEL_OF[input.provider];
  const identity = await identityFor(deps.sql, input.agencyId, channel, input.externalUser);
  if (!identity) return { ok: false, message: "Só quem está vinculado à equipe no Spherum pode decidir pedidos." };
  let result;
  try {
    result = await decideAction(deps, {
      actionId: input.actionId,
      agencyId: input.agencyId,
      userId: identity.userId,
      approve: input.approve,
      scope: "once",
      via: channel,
    });
  } catch (error) {
    if (error instanceof XodoError) return { ok: false, message: error.message };
    throw error;
  }
  const run = await one<{ conversation_id: string | null }>(deps.sql, `select conversation_id from xodo_runs where id = $1`, [result.runId]);
  let resumed = false;
  try {
    resumed = (await resumeRun(deps, result.runId)) !== null;
  } finally {
    if (run?.conversation_id) await flushOutbox(deps, adapters, { conversationId: run.conversation_id });
  }
  const verb = input.approve ? (result.status === "executed" ? "Aprovado e feito." : "Aprovado.") : "Negado.";
  return { ok: true, message: verb, runId: result.runId, resumed };
}

/** Conexão de canal ativa (para as rotas de entrada acharem a agência). */
export async function channelConnection(sql: Sql, connectionId: string, provider: ChannelProvider) {
  const row = await one<{ id: string; agency_id: string; metadata: unknown; status: string }>(
    sql,
    `select id, agency_id, metadata, status from integration_connections where id = $1 and provider = $2`,
    [connectionId, provider],
  );
  if (!row || row.status === "revoked") return null;
  return { id: row.id, agencyId: row.agency_id, metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {} };
}
