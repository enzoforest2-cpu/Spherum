import { access } from "../integrations/store";
import { one, parseJson, type Sql } from "../xodos/db";
import { integrationDepsOf, type Adapters, type ChannelDeps, type OutboundApproval } from "./types";

/**
 * Fila de entrega dos canais (modelo do Rakazo): o que o xodó escreve numa conversa de canal
 * entra em channel_outbox junto com a mensagem e é entregue logo depois. Falhou, tenta de
 * novo com espera crescente (até 1 minuto) e desiste depois de 5 tentativas.
 *
 * Em cada conversa, a entrega segue a ordem: uma mensagem só sai depois das anteriores. Os
 * pedaços de uma mensagem longa ficam guardados na primeira tentativa, e uma nova tentativa
 * continua do pedaço que faltou (sem repetir o que já chegou).
 */

export const MAX_ATTEMPTS = 5;

/** Divide um texto em pedaços que cabem no canal, preferindo quebrar em parágrafos e linhas. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    let at = cut > max * 0.5 ? cut : max;
    // Não parte um emoji (par substituto) ao meio.
    if (at === max && /[\uD800-\uDBFF]/.test(rest[at - 1])) at -= 1;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out.length ? out : [""];
}

type Part = { text: string; approvals: OutboundApproval[] };

type OutboxRow = {
  id: string;
  agency_id: string;
  conversation_id: string;
  text: string;
  approvals: unknown;
  attempts: number;
  parts: unknown;
  parts_sent: number;
};

type ConversationInfo = {
  id: string;
  connection_id: string | null;
  external_key: string;
  metadata: unknown;
  xodo_name: string;
  provider: string | null;
};

export type ThreadAction = { id: string; status: string; number: number };

/**
 * Pedidos de uma conversa do canal (de todos os xodós naquela thread ou número), cada um com o
 * número fixo que vale para "aprovar N" (channel_seq, dado quando o pedido nasce). A fila, os
 * botões e o núcleo usam esse mesmo número, que não muda quando outros pedidos são decididos.
 */
export async function threadActions(
  sql: Sql,
  connectionId: string,
  externalKey: string,
  agencyId: string,
  opts: { pendingOnly?: boolean } = {},
): Promise<ThreadAction[]> {
  const rows = await sql.query<{ id: string; status: string; seq: number | null }>(
    `select a.id, a.status, a.channel_seq as seq from xodo_actions a
       join xodo_runs r on r.id = a.run_id
       join xodo_conversations c on c.id = r.conversation_id
      where c.connection_id = $1 and c.external_key = $2 and a.agency_id = $3
        and (a.status = 'pending' or (not $4 and a.channel_seq is not null))
      order by a.created_at, a.call_index`,
    [connectionId, externalKey, agencyId, opts.pendingOnly ?? false],
  );
  // Pedido sem número (anterior à numeração) fica com a posição entre os pendentes.
  let position = 0;
  return rows.map((r) => ({ id: r.id, status: r.status, number: r.seq ?? (r.status === "pending" ? (position += 1) : 0) }));
}

/** Ids dos pedidos pendentes de uma conversa do canal. */
export async function pendingInThread(sql: Sql, connectionId: string, externalKey: string, agencyId: string): Promise<string[]> {
  return (await threadActions(sql, connectionId, externalKey, agencyId, { pendingOnly: true })).map((a) => a.id);
}

/** Pedidos que ainda esperam decisão (um pedido decidido no app não vira botão no canal), com o número fixo. */
async function stillPending(
  sql: Sql,
  conversation: ConversationInfo,
  agencyId: string,
  approvals: { action_id: string; summary: string }[],
): Promise<{ approvals: OutboundApproval[]; total: number }> {
  if (!approvals.length || !conversation.connection_id) return { approvals: [], total: 0 };
  const pending = await threadActions(sql, conversation.connection_id, conversation.external_key, agencyId, { pendingOnly: true });
  const numbers = new Map(pending.map((a) => [a.id, a.number]));
  return {
    approvals: approvals.flatMap((a) => {
      const index = numbers.get(a.action_id);
      return index ? [{ actionId: a.action_id, summary: a.summary, index }] : [];
    }),
    total: pending.length,
  };
}

/** Texto do pedido de aprovação com a numeração da conversa (a mesma que "aprovar N" entende). */
function approvalText(approvals: OutboundApproval[], total: number): string {
  const list = total <= 1 ? `• ${approvals[0].summary}` : approvals.map((a) => `${a.index}. ${a.summary}`).join("\n");
  return `Preciso de aprovação para:\n${list}`;
}

/** Pega a próxima mensagem a entregar: a mais antiga de uma conversa que não tem outra na frente. */
async function claimNext(sql: Sql, now: Date, conversationId: string | null): Promise<OutboxRow | null> {
  return one<OutboxRow>(
    sql,
    // next_attempt_at passa a marcar a hora da tentativa (a faxina usa para achar entregas presas).
    `update channel_outbox set status = 'sending', attempts = attempts + 1, next_attempt_at = $1::timestamptz
      where id = (
        select o.id from channel_outbox o
         where o.status = 'pending' and o.next_attempt_at <= $1::timestamptz and ($2::uuid is null or o.conversation_id = $2::uuid)
           and not exists (
             select 1 from channel_outbox p
              where p.conversation_id = o.conversation_id and p.id < o.id and p.status in ('pending', 'sending'))
         order by o.id limit 1 for update skip locked)
      returning id, agency_id, conversation_id, text, approvals, attempts, parts, parts_sent`,
    [now.toISOString(), conversationId],
  );
}

/** Pedaços da mensagem: calculados e guardados na primeira tentativa, reaproveitados depois. */
async function partsOf(
  sql: Sql,
  row: OutboxRow,
  conversation: ConversationInfo,
  maxChars: number,
): Promise<Part[] | null> {
  const saved = parseJson<Part[]>(row.parts);
  if (saved) return saved;
  const asked = parseJson<{ action_id: string; summary: string }[]>(row.approvals) ?? [];
  const { approvals, total } = await stillPending(sql, conversation, row.agency_id, asked);
  // Tudo já foi decidido no app: não há o que pedir no canal.
  if (asked.length && !approvals.length) return null;
  const chunks = chunkText(approvals.length ? approvalText(approvals, total) : row.text, maxChars);
  const parts = chunks.map((text, i) => ({ text, approvals: i === chunks.length - 1 ? approvals : [] }));
  await sql.query(`update channel_outbox set parts = $2::jsonb where id = $1`, [row.id, JSON.stringify(parts)]);
  return parts;
}

/** Botões só dos pedidos que ainda esperam decisão na hora do envio. */
async function openApprovals(sql: Sql, approvals: OutboundApproval[]): Promise<OutboundApproval[]> {
  if (!approvals.length) return [];
  const rows = await sql.query<{ id: string }>(`select id from xodo_actions where id = any($1::uuid[]) and status = 'pending'`, [
    approvals.map((a) => a.actionId),
  ]);
  const open = new Set(rows.map((r) => r.id));
  return approvals.filter((a) => open.has(a.actionId));
}

export async function flushOutbox(
  deps: ChannelDeps,
  adapters: Adapters,
  opts: { conversationId?: string | null; limit?: number; deadline?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const { sql } = deps;
  const integrations = integrationDepsOf(deps);
  let sent = 0;
  let failed = 0;
  // Uma por vez: se o tempo da função acabar, só a mensagem em envio fica no meio.
  for (let i = 0; i < (opts.limit ?? 20); i += 1) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const now = deps.now ? deps.now() : new Date();
    const row = await claimNext(sql, now, opts.conversationId ?? null);
    if (!row) break;
    let partsSent = row.parts_sent;
    try {
      const conversation = await one<ConversationInfo>(
        sql,
        `select c.id, c.connection_id, c.external_key, c.metadata, x.name as xodo_name, ic.provider
           from xodo_conversations c join xodos x on x.id = c.xodo_id
           left join integration_connections ic on ic.id = c.connection_id
          where c.id = $1`,
        [row.conversation_id],
      );
      if (!conversation?.connection_id || !conversation.provider) throw new Error("A conversa ficou sem conexão.");
      const adapter = adapters[conversation.provider as keyof Adapters];
      if (!adapter) throw new Error(`Canal ${conversation.provider} não está disponível.`);
      const parts = await partsOf(sql, row, conversation, adapter.maxChars);
      if (parts) {
        const a = await access(integrations, row.agency_id, conversation.connection_id);
        const target = parseJson<Record<string, unknown>>(conversation.metadata) ?? {};
        for (; partsSent < parts.length; partsSent += 1) {
          const part = parts[partsSent];
          await adapter.send(
            { deps: integrations, access: a, target, xodoName: conversation.xodo_name },
            { text: part.text, approvals: await openApprovals(sql, part.approvals) },
          );
          await sql.query(`update channel_outbox set parts_sent = $2 where id = $1`, [row.id, partsSent + 1]);
        }
      }
      await sql.query(`update channel_outbox set status = 'sent', sent_at = $2::timestamptz, error = $3 where id = $1`, [
        row.id,
        now.toISOString(),
        parts ? null : "Já decidido.",
      ]);
      sent += 1;
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const giveUp = row.attempts >= MAX_ATTEMPTS;
      const wait = Math.min(2 ** row.attempts, 60) * 1000;
      await sql.query(
        `update channel_outbox set status = $2, error = $3, next_attempt_at = $4::timestamptz where id = $1`,
        [row.id, giveUp ? "failed" : "pending", message, new Date(now.getTime() + wait).toISOString()],
      );
      if (giveUp) failed += 1;
      console.warn("[canais] entrega falhou", row.id, message);
    }
  }
  return { sent, failed };
}

/**
 * Faxina do cron: entrega presa no meio (a função acabou durante o envio) volta para a fila se
 * ainda tem tentativas; eventos antigos, códigos vencidos e entregas encerradas há mais de 30
 * dias saem (o texto continua em xodo_messages).
 */
export async function cleanupChannels(sql: Sql, now: Date) {
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const stuck = await sql.query<{ status: string }>(
    `update channel_outbox
        set status = case when attempts >= $2 then 'failed' else 'pending' end,
            error = 'A entrega parou no meio.'
      where status = 'sending' and next_attempt_at < $1::timestamptz returning status`,
    [tenMinutesAgo, MAX_ATTEMPTS],
  );
  await sql.query(`delete from channel_events where received_at < $1::timestamptz`, [new Date(now.getTime() - 7 * 86_400_000).toISOString()]);
  await sql.query(`delete from channel_pairing_codes where expires_at < $1::timestamptz`, [now.toISOString()]);
  await sql.query(`delete from event_deliveries where received_at < $1::timestamptz`, [monthAgo]);
  await sql.query(`delete from channel_outbox where status in ('sent', 'failed') and created_at < $1::timestamptz`, [monthAgo]);
  return { stuckDeliveries: stuck.length, requeued: stuck.filter((r) => r.status === "pending").length };
}
