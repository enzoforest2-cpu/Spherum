import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { addTask, createProject } from "./projects";

/**
 * Chat da equipe. Toda agência ganha #geral, #criação e #tráfego na primeira leitura. Conversa
 * direta só aparece para as duas pessoas. Mencionar um xodó (@Nome) entrega o pedido a ele; a
 * resposta fica na conversa do xodó (a rota é quem inicia a execução).
 */

export const DEFAULT_CHANNELS: [string, string][] = [["geral", "Avisos e combinados da equipe"], ["criação", "Peças, versões e revisões"], ["tráfego", "Campanhas e verbas"]];
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function ensureDefaults(sql: Sql, agencyId: string) {
  for (const [name, description] of DEFAULT_CHANNELS) {
    await sql.query(`insert into team_channels (agency_id, kind, name, description) values ($1, 'canal', $2, $3) on conflict do nothing`, [agencyId, name, description]);
  }
}

async function channelFor(sql: Sql, agencyId: string, userId: string, id: string) {
  const c = await one<{ id: string; kind: string; name: string; member_a: string | null; member_b: string | null; client_id: string | null }>(
    sql, `select id, kind, name, member_a, member_b, client_id from team_channels where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!c || (c.kind === "direta" && userId !== c.member_a && userId !== c.member_b)) throw new XodoError("Canal não encontrado.", 404);
  return c;
}

export const channelInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  client_id: z.uuid().nullable().optional(),
});

export async function createChannel(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = channelInput.parse(raw);
  const name = slug(input.name);
  if (name.length < 2) throw new XodoError("Use letras ou números no nome.", 400);
  if (input.client_id && !(await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [input.client_id, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
  if (await one(sql, `select 1 from team_channels where agency_id = $1 and name = $2 and kind <> 'direta'`, [agencyId, name])) throw new XodoError("Já existe um canal com esse nome.", 409);
  return (await one<{ id: string }>(
    sql,
    `insert into team_channels (agency_id, kind, name, description, client_id, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [agencyId, input.client_id ? "cliente" : "canal", name, input.description ?? null, input.client_id ?? null, userId],
  ))!;
}

/** Conversa direta com outra pessoa da equipe (abre a existente ou cria). */
export async function directChannel(sql: Sql, agencyId: string, userId: string, otherId: string) {
  if (otherId === userId) throw new XodoError("Escolha outra pessoa.", 400);
  if (!(await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, otherId]))) throw new XodoError("Essa pessoa não é da equipe.", 400);
  const [a, b] = [userId, otherId].sort();
  await sql.query(`insert into team_channels (agency_id, kind, name, member_a, member_b, created_by) values ($1, 'direta', 'direta', $2, $3, $4) on conflict do nothing`, [agencyId, a, b, userId]);
  return (await one<{ id: string }>(sql, `select id from team_channels where agency_id = $1 and kind = 'direta' and member_a = $2 and member_b = $3`, [agencyId, a, b]))!;
}

export async function postMessage(sql: Sql, agencyId: string, userId: string, channelId: string, text: string, system = false) {
  const body = z.string().trim().min(1).max(4000).parse(text);
  await channelFor(sql, agencyId, userId, channelId);
  const row = await one<{ id: number }>(sql, `insert into team_messages (channel_id, agency_id, author_user, system, text) values ($1, $2, $3, $4, $5) returning id`, [channelId, agencyId, system ? null : userId, system, body]);
  if (!system) await markRead(sql, channelId, userId);
  return { id: Number(row!.id) };
}

/** Xodós citados na mensagem (@Nome, sem acento e sem diferença de maiúsculas). */
export async function mentionedXodos(sql: Sql, agencyId: string, text: string) {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const tags = [...norm(text).matchAll(/@([a-z0-9_]+)/g)].map((m) => m[1]);
  if (!tags.length) return [];
  const xs = await sql.query<{ id: string; name: string }>(`select id, name from xodos where agency_id = $1 and status <> 'paused'`, [agencyId]);
  return xs.filter((x) => tags.includes(norm(x.name).replace(/[^a-z0-9_]/g, "")));
}

export async function markRead(sql: Sql, channelId: string, userId: string) {
  await sql.query(
    `insert into team_reads (channel_id, user_id, last_read_id) values ($1, $2, coalesce((select max(id) from team_messages where channel_id = $1), 0))
     on conflict (channel_id, user_id) do update set last_read_id = excluded.last_read_id`,
    [channelId, userId],
  );
}

export async function setPin(sql: Sql, agencyId: string, userId: string, channelId: string, text: string | null) {
  await channelFor(sql, agencyId, userId, channelId);
  await sql.query(`update team_channels set pinned_text = $2 where id = $1`, [channelId, text ? text.slice(0, 4000) : null]);
}

export async function listMessages(sql: Sql, agencyId: string, userId: string, channelId: string, read = true) {
  await channelFor(sql, agencyId, userId, channelId);
  const rows = await sql.query<{ id: number; author_user: string | null; author_name: string | null; system: boolean; text: string; created_at: string }>(
    `select * from (select m.id, m.author_user, coalesce(p.full_name, u.email) as author_name, m.system, m.text, m.created_at::text
       from team_messages m left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
      where m.channel_id = $1 order by m.id desc limit 200) t order by id`,
    [channelId],
  );
  if (read) await markRead(sql, channelId, userId);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Canais que a pessoa vê, com as não lidas e a fixada. */
export async function chatBoard(sql: Sql, agencyId: string, userId: string) {
  await ensureDefaults(sql, agencyId);
  const rows = await sql.query<{ id: string; kind: string; name: string; description: string | null; client_id: string | null; other: string | null; other_name: string | null; pinned_text: string | null; unread: number; last_at: string | null }>(
    `select c.id, c.kind, c.name, c.description, c.client_id, o.id as other, coalesce(op.full_name, o.email) as other_name, c.pinned_text,
            (select count(*)::int from team_messages m where m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and coalesce(m.author_user::text, '') <> $2::text) as unread,
            (select max(created_at)::text from team_messages m where m.channel_id = c.id) as last_at
       from team_channels c
       left join team_reads r on r.channel_id = c.id and r.user_id = $2
       left join auth.users o on c.kind = 'direta' and o.id = case when c.member_a = $2 then c.member_b else c.member_a end
       left join profiles op on op.id = o.id
      where c.agency_id = $1 and (c.kind <> 'direta' or $2 in (c.member_a, c.member_b))
      order by (c.kind = 'direta'), (c.kind = 'cliente'), c.created_at`,
    [agencyId, userId],
  );
  return rows;
}

/** "Virar tarefa": a mensagem vira tarefa no projeto interno "Combinados da equipe". */
export async function messageToTask(sql: Sql, agencyId: string, userId: string, raw: unknown, now = new Date()) {
  const input = z.object({ title: z.string().trim().min(3).max(200), assignee_user: z.uuid().nullable().optional(), due_date: z.iso.date().nullable().optional() }).parse(raw);
  const name = "Combinados da equipe";
  let p = await one<{ id: string; due_date: string }>(sql, `select id, due_date::text from projects where agency_id = $1 and client_id is null and name = $2 and status <> 'done'`, [agencyId, name]);
  const due = input.due_date ?? new Date(now.getTime() + 7 * 864e5).toISOString().slice(0, 10);
  if (!p) {
    const created = await createProject(sql, agencyId, userId, { name, owner_user: userId, tags: ["Equipe"], due_date: due > now.toISOString().slice(0, 10) ? due : new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10) }, now);
    p = { id: created.id, due_date: due };
  }
  if (due > p.due_date) await sql.query(`update projects set due_date = $2 where id = $1`, [p.id, due]);
  return addTask(sql, agencyId, p.id, { title: input.title, assignee_user: input.assignee_user ?? null, due_date: input.due_date ?? null });
}
