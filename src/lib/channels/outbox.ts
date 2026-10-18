import { access } from "../integrations/store";
import { one, parseJson, type Sql } from "../xodos/db";
import { integrationDepsOf, type Adapters, type ChannelDeps, type OutboundApproval } from "./types";

/**
 * Fila de entrega dos canais (modelo do Rakazo): o que o xodó escreve numa conversa de canal
 * entra em channel_outbox junto com a mensagem e é entregue logo depois. Falhou, tenta de
 * novo com espera crescente (até 1 minuto) e desiste depois de 5 tentativas.
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

type OutboxRow = {
  id: string;
  agency_id: string;
  conversation_id: string;
  text: string;
  approvals: unknown;
  attempts: number;
};

type ConversationInfo = {
  id: string;
  connection_id: string | null;
  external_key: string;
  metadata: unknown;
  xodo_name: string;
  provider: string | null;
};

/**
 * Pedidos pendentes de uma conversa do canal (de todos os xodós naquela thread ou número), na
 * ordem que vale para "aprovar N". A fila, os botões e o núcleo usam esta mesma numeração.
 */
export async function pendingInThread(sql: Sql, connectionId: string, externalKey: string, agencyId: string): Promise<string[]> {
  const rows = await sql.query<{ id: string }>(
    `select a.id from xodo_actions a
       join xodo_runs r on r.id = a.run_id
       join xodo_conversations c on c.id = r.conversation_id
      where c.connection_id = $1 and c.external_key = $2 and a.agency_id = $3 and a.status = 'pending'
      order by a.created_at, a.call_index`,
    [connectionId, externalKey, agencyId],
  );
  return rows.map((r) => r.id);
}

/** Pedidos que ainda esperam decisão (um pedido decidido no app não vira botão no canal), com o número da conversa. */
async function stillPending(
  sql: Sql,
  conversation: ConversationInfo,
  agencyId: string,
  approvals: { action_id: string; summary: string }[],
): Promise<{ approvals: OutboundApproval[]; total: number }> {
  if (!approvals.length || !conversation.connection_id) return { approvals: [], total: 0 };
  const order = await pendingInThread(sql, conversation.connection_id, conversation.external_key, agencyId);
  const position = new Map(order.map((id, i) => [id, i + 1]));
  return {
    approvals: approvals.flatMap((a) => {
      const index = position.get(a.action_id);
      return index ? [{ actionId: a.action_id, summary: a.summary, index }] : [];
    }),
    total: order.length,
  };
}

/** Texto do pedido de aprovação com a numeração da conversa (a mesma que "aprovar N" entende). */
function approvalText(approvals: OutboundApproval[], total: number): string {
  const list = total <= 1 ? `• ${approvals[0].summary}` : approvals.map((a) => `${a.index}. ${a.summary}`).join("\n");
  return `Preciso de aprovação para:\n${list}`;
}

export async function flushOutbox(
  deps: ChannelDeps,
  adapters: Adapters,
  opts: { conversationId?: string | null; limit?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const { sql } = deps;
  const now = deps.now ? deps.now() : new Date();
  const claimed = await sql.query<OutboxRow>(
    // next_attempt_at passa a marcar a hora da tentativa (a faxina usa para achar entregas presas).
    `update channel_outbox set status = 'sending', attempts = attempts + 1, next_attempt_at = $1::timestamptz
      where id in (
        select id from channel_outbox
         where status = 'pending' and next_attempt_at <= $1::timestamptz and ($2::uuid is null or conversation_id = $2::uuid)
         order by id limit $3 for update skip locked)
      returning id, agency_id, conversation_id, text, approvals, attempts`,
    [now.toISOString(), opts.conversationId ?? null, opts.limit ?? 20],
  );
  let sent = 0;
  let failed = 0;
  const integrations = integrationDepsOf(deps);
  for (const row of [...claimed].sort((a, b) => Number(a.id) - Number(b.id))) {
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
      const asked = parseJson<{ action_id: string; summary: string }[]>(row.approvals) ?? [];
      const { approvals, total } = await stillPending(sql, conversation, row.agency_id, asked);
      if (asked.length && !approvals.length) {
        // Tudo já foi decidido no app: não há o que pedir no canal.
        await sql.query(`update channel_outbox set status = 'sent', sent_at = $2::timestamptz, error = 'Já decidido.' where id = $1`, [
          row.id,
          now.toISOString(),
        ]);
        continue;
      }
      const a = await access(integrations, row.agency_id, conversation.connection_id);
      const chunks = chunkText(approvals.length ? approvalText(approvals, total) : row.text, adapter.maxChars);
      for (const [i, text] of chunks.entries()) {
        await adapter.send(
          { deps: integrations, access: a, target: parseJson<Record<string, unknown>>(conversation.metadata) ?? {}, xodoName: conversation.xodo_name },
          { text, approvals: i === chunks.length - 1 ? approvals : [] },
        );
      }
      await sql.query(`update channel_outbox set status = 'sent', sent_at = $2::timestamptz, error = null where id = $1`, [
        row.id,
        now.toISOString(),
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

/** Faxina do cron: entregas presas no meio, eventos antigos e códigos vencidos. */
export async function cleanupChannels(sql: Sql, now: Date) {
  const stuck = await sql.query(
    `update channel_outbox set status = 'failed', error = 'A entrega parou no meio.'
      where status = 'sending' and next_attempt_at < $1::timestamptz returning id`,
    [new Date(now.getTime() - 10 * 60 * 1000).toISOString()],
  );
  await sql.query(`delete from channel_events where received_at < $1::timestamptz`, [new Date(now.getTime() - 7 * 86_400_000).toISOString()]);
  await sql.query(`delete from channel_pairing_codes where expires_at < $1::timestamptz`, [now.toISOString()]);
  await sql.query(`delete from event_deliveries where received_at < $1::timestamptz`, [new Date(now.getTime() - 30 * 86_400_000).toISOString()]);
  return { stuckDeliveries: stuck.length };
}
