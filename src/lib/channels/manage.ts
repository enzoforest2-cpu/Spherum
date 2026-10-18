import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { CAN_MANAGE, type Role } from "../xodos/http";
import { XodoError } from "../xodos/runner";
import { flushOutbox } from "./outbox";
import type { Adapters, ChannelDeps, ChannelProvider } from "./types";

/**
 * Gestão dos canais pela equipe: qual xodó atende em cada canal conectado, as contas vinculadas
 * pelo pareamento e as conversas abertas.
 */

const CHANNEL_PROVIDERS: ChannelProvider[] = ["slack", "whatsapp_cloud", "whatsapp_qr", "telegram"];

export const xodoChannelInput = z.object({
  connection_id: z.uuid(),
  // Slack: id de um canal (C… ou G…) ou "*" para o workspace todo. Nos outros canais, sempre "*".
  scope: z.string().trim().min(1).max(100).default("*"),
  enabled: z.boolean().default(true),
});

/** Liga um xodó a um canal conectado (ou muda o escopo/ativação). */
export async function setXodoChannel(sql: Sql, agencyId: string, xodoId: string, raw: unknown) {
  const input = xodoChannelInput.parse(raw);
  const xodo = await one(sql, `select 1 from xodos where id = $1 and agency_id = $2`, [xodoId, agencyId]);
  if (!xodo) throw new XodoError("Xodó não encontrado", 404);
  const conn = await one<{ provider: string; status: string }>(
    sql,
    `select provider, status from integration_connections where id = $1 and agency_id = $2`,
    [input.connection_id, agencyId],
  );
  if (!conn || conn.status === "revoked") throw new XodoError("Conexão não encontrada nesta agência.", 404);
  if (!CHANNEL_PROVIDERS.includes(conn.provider as ChannelProvider)) throw new XodoError("Essa conexão não é um canal de mensagens.");
  if (input.scope !== "*" && (conn.provider !== "slack" || !/^[CG][A-Z0-9]{6,}$/.test(input.scope))) {
    throw new XodoError('Escopo inválido: use "*" ou, no Slack, o id de um canal.');
  }
  const row = await one<{ id: string }>(
    sql,
    `insert into xodo_channels (agency_id, xodo_id, connection_id, scope, enabled) values ($1, $2, $3, $4, $5)
     on conflict (connection_id, scope, xodo_id) do update set enabled = excluded.enabled
     returning id`,
    [agencyId, xodoId, input.connection_id, input.scope, input.enabled],
  );
  return row!.id;
}

export async function removeXodoChannel(sql: Sql, agencyId: string, xodoId: string, id: string) {
  await sql.query(`delete from xodo_channels where id = $1 and agency_id = $2 and xodo_id = $3`, [id, agencyId, xodoId]);
}

export async function listXodoChannels(sql: Sql, agencyId: string, xodoId: string) {
  return sql.query(
    `select c.id, c.connection_id, c.scope, c.enabled, ic.provider, ic.label, ic.status
       from xodo_channels c join integration_connections ic on ic.id = c.connection_id
      where c.agency_id = $1 and c.xodo_id = $2 order by c.created_at`,
    [agencyId, xodoId],
  );
}

/** Contas de canal vinculadas: cada pessoa vê as suas; owner e admin veem todas. */
export async function listIdentities(sql: Sql, agencyId: string, userId: string, role: Role) {
  return sql.query(
    `select id, provider, external_user, user_id, display_name, created_at::text from channel_identities
      where agency_id = $1 and ($2 or user_id = $3) order by created_at desc`,
    [agencyId, CAN_MANAGE.includes(role), userId],
  );
}

export async function unlinkIdentity(sql: Sql, agencyId: string, id: string, userId: string, role: Role) {
  const row = await one(
    sql,
    `delete from channel_identities where id = $1 and agency_id = $2 and ($3 or user_id = $4) returning id`,
    [id, agencyId, CAN_MANAGE.includes(role), userId],
  );
  if (!row) throw new XodoError("Vínculo não encontrado", 404);
}

/** Conversas de canal de um xodó, da mais recente para a mais antiga. */
export async function listConversations(sql: Sql, agencyId: string, xodoId: string) {
  return sql.query(
    `select id, channel, title, last_message_at::text, created_at::text from xodo_conversations
      where agency_id = $1 and xodo_id = $2 order by last_message_at desc limit 50`,
    [agencyId, xodoId],
  );
}

/** Entrega o que uma execução escreveu numa conversa de canal (depois de uma decisão no app, por exemplo). */
export async function deliverRun(deps: ChannelDeps, adapters: Adapters, runId: string) {
  const run = await one<{ conversation_id: string | null }>(deps.sql, `select conversation_id from xodo_runs where id = $1`, [runId]);
  if (run?.conversation_id) await flushOutbox(deps, adapters, { conversationId: run.conversation_id });
}
