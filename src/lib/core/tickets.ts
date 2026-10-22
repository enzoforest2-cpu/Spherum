import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import type { Mailer } from "./email";

/**
 * Chamados: o cliente abre pelo portal (ou a equipe registra o que chegou por fora). Cada prioridade
 * tem um prazo de primeira resposta (horas, por agência). A primeira mensagem da equipe marca a
 * resposta; resolver fecha o chamado e avisa o cliente.
 */

export const PRIORITIES = ["alta", "media", "baixa"] as const;
export type Sla = Record<(typeof PRIORITIES)[number], number>;
export const DEFAULT_SLA: Sla = { alta: 2, media: 8, baixa: 24 };

export const slaInput = z.object({ alta: z.number().min(0.5).max(168), media: z.number().min(0.5).max(168), baixa: z.number().min(0.5).max(336) });

export const ticketInput = z.object({
  client_id: z.uuid(),
  subject: z.string().trim().min(1).max(160),
  priority: z.enum(PRIORITIES).default("media"),
  text: z.string().trim().max(4000).optional(),
  assignee_user: z.uuid().nullable().optional(),
});

export const ticketPatch = z.object({
  priority: z.enum(PRIORITIES).optional(),
  assignee_user: z.uuid().nullable().optional(),
  status: z.enum(["aberto", "resolvido"]).optional(),
});

async function slaOf(sql: Sql, agencyId: string): Promise<Sla> {
  const a = await one<{ ticket_sla: Sla | string | null }>(sql, `select ticket_sla from agencies where id = $1`, [agencyId]);
  const raw = typeof a?.ticket_sla === "string" ? JSON.parse(a.ticket_sla) : a?.ticket_sla;
  return { ...DEFAULT_SLA, ...(raw ?? {}) };
}

const dueFrom = (from: Date, hours: number) => new Date(from.getTime() + hours * 3_600_000).toISOString();

export async function setSla(sql: Sql, agencyId: string, raw: unknown) {
  const sla = slaInput.parse(raw);
  await sql.query(`update agencies set ticket_sla = $2::jsonb where id = $1`, [agencyId, json(sla)]);
  // Os abertos sem resposta passam a seguir o prazo novo.
  for (const p of PRIORITIES) {
    await sql.query(
      `update tickets set due_at = created_at + make_interval(secs => $3 * 3600) where agency_id = $1 and priority = $2 and status = 'aberto' and first_response_at is null`,
      [agencyId, p, sla[p]],
    );
  }
  return sla;
}

async function notifyAgency(sql: Sql, agencyId: string, kind: string, title: string, data: Record<string, unknown>) {
  await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, $2, $3, $4::jsonb)`, [agencyId, kind, title.slice(0, 200), json(data)]);
}

/** Abre um chamado. side = cliente (pelo portal) ou agencia (registrado pela equipe). */
export async function openTicket(sql: Sql, agencyId: string, userId: string, side: "cliente" | "agencia", raw: unknown, now = new Date()) {
  const input = ticketInput.parse(raw);
  const c = await one<{ name: string }>(sql, `select name from clients where id = $1 and agency_id = $2 and archived_at is null`, [input.client_id, agencyId]);
  if (!c) throw new XodoError("Cliente não encontrado.", 404);
  if (side === "cliente" && !input.text) throw new XodoError("Conte o que está acontecendo.", 400);
  if (input.assignee_user) {
    const m = await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, input.assignee_user]);
    if (!m) throw new XodoError("Essa pessoa não é da equipe.", 400);
  }
  // Sem responsável escolhido: quem cuida do cliente.
  const owner = input.assignee_user ?? (await one<{ owner_user_id: string | null }>(sql, `select owner_user_id from clients where id = $1`, [input.client_id]))?.owner_user_id ?? null;
  const sla = await slaOf(sql, agencyId);
  const row = await one<{ id: string }>(
    sql,
    `insert into tickets (agency_id, client_id, subject, priority, assignee_user, source, opened_by, due_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [agencyId, input.client_id, input.subject, input.priority, owner, side === "cliente" ? "portal" : "equipe", userId, dueFrom(now, sla[input.priority]), now.toISOString()],
  );
  if (input.text) {
    await sql.query(`insert into ticket_messages (ticket_id, agency_id, side, author_user, text) values ($1, $2, 'cliente', $3, $4)`, [row!.id, agencyId, side === "cliente" ? userId : null, input.text]);
  }
  if (side === "cliente") await notifyAgency(sql, agencyId, "chamado_aberto", `Chamado de ${c.name}: ${input.subject}`, { client_id: input.client_id, ticket_id: row!.id });
  return row!;
}

async function ticketOf(sql: Sql, agencyId: string, id: string) {
  const t = await one<{ id: string; client_id: string; client_name: string; subject: string; status: string; priority: string; created_at: string; first_response_at: string | null }>(
    sql,
    `select t.id, t.client_id, c.name as client_name, t.subject, t.status, t.priority, t.created_at::text, t.first_response_at::text
       from tickets t join clients c on c.id = t.client_id where t.id = $1 and t.agency_id = $2`,
    [id, agencyId],
  );
  if (!t) throw new XodoError("Chamado não encontrado.", 404);
  return t;
}

/** Mensagem no chamado. A primeira da equipe é a primeira resposta; a do cliente reabre um resolvido. */
export async function replyTicket(deps: { sql: Sql; mail?: Mailer; appUrl?: string }, agencyId: string, userId: string, side: "cliente" | "agencia", id: string, text: string) {
  const body = z.string().trim().min(1).max(4000).parse(text);
  const t = await ticketOf(deps.sql, agencyId, id);
  await deps.sql.query(`insert into ticket_messages (ticket_id, agency_id, side, author_user, text) values ($1, $2, $3, $4, $5)`, [id, agencyId, side, userId, body]);
  if (side === "agencia") {
    await deps.sql.query(`update tickets set first_response_at = coalesce(first_response_at, now()) where id = $1`, [id]);
    await mailClient(deps, t.client_id, `resposta no chamado "${t.subject}"`, body);
  } else {
    if (t.status === "resolvido") await deps.sql.query(`update tickets set status = 'aberto', resolved_at = null where id = $1`, [id]);
    await notifyAgency(deps.sql, agencyId, "chamado_mensagem", `${t.client_name} respondeu: ${t.subject}`, { client_id: t.client_id, ticket_id: id });
  }
}

async function mailClient(deps: { sql: Sql; mail?: Mailer; appUrl?: string }, clientId: string, subject: string, line: string) {
  if (!deps.mail) return;
  const rows = await deps.sql.query<{ email: string | null; agency: string }>(
    `select u.email, a.name as agency from client_portal_users p join auth.users u on u.id = p.user_id join clients c on c.id = p.client_id join agencies a on a.id = c.agency_id where p.client_id = $1`,
    [clientId],
  );
  const to = rows.map((r) => r.email).filter((e): e is string => !!e);
  if (!to.length) return;
  const link = `${(deps.appUrl ?? "https://spherum.com.br").replace(/\/+$/, "")}/cliente`;
  await deps.mail({ to, subject: `${rows[0].agency}: ${subject}`.slice(0, 200), text: `${line.slice(0, 2000)}\n\nAbra o portal para ver: ${link}` }).catch(() => false);
}

export async function updateTicket(deps: { sql: Sql; mail?: Mailer; appUrl?: string }, agencyId: string, id: string, raw: unknown, now = new Date()) {
  const input = ticketPatch.parse(raw);
  const t = await ticketOf(deps.sql, agencyId, id);
  if (input.assignee_user) {
    const m = await one(deps.sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, input.assignee_user]);
    if (!m) throw new XodoError("Essa pessoa não é da equipe.", 400);
  }
  if (input.assignee_user !== undefined) await deps.sql.query(`update tickets set assignee_user = $2 where id = $1`, [id, input.assignee_user]);
  if (input.priority && input.priority !== t.priority) {
    const sla = await slaOf(deps.sql, agencyId);
    await deps.sql.query(`update tickets set priority = $2, due_at = case when first_response_at is null then $3::timestamptz else due_at end where id = $1`,
      [id, input.priority, dueFrom(new Date(t.created_at), sla[input.priority])]);
  }
  if (input.status && input.status !== t.status) {
    await deps.sql.query(`update tickets set status = $2, resolved_at = case when $2 = 'resolvido' then now() else null end where id = $1`, [id, input.status]);
    if (input.status === "resolvido") await mailClient(deps, t.client_id, `chamado resolvido: ${t.subject}`, `A agência marcou o chamado "${t.subject}" como resolvido. Se ainda precisar de algo, responda pelo portal.`);
  }
  void now;
}

/** Chamados da agência com prazo, conversa e os números (primeira resposta e prazo em 30 dias, por pessoa). */
export async function ticketBoard(sql: Sql, agencyId: string, now = new Date()) {
  const [tickets, msgs, sla] = await Promise.all([
    sql.query<{ id: string; client_id: string; client_name: string; subject: string; priority: string; status: string; assignee_user: string | null; assignee_name: string | null; source: string; due_at: string; first_response_at: string | null; resolved_at: string | null; created_at: string }>(
      `select t.id, t.client_id, c.name as client_name, t.subject, t.priority, t.status, t.assignee_user, coalesce(p.full_name, u.email) as assignee_name, t.source,
              t.due_at::text, t.first_response_at::text, t.resolved_at::text, t.created_at::text
         from tickets t join clients c on c.id = t.client_id left join profiles p on p.id = t.assignee_user left join auth.users u on u.id = t.assignee_user
        where t.agency_id = $1 and (t.status = 'aberto' or t.resolved_at > $2::timestamptz - interval '30 days') order by t.created_at desc limit 300`,
      [agencyId, now.toISOString()],
    ),
    sql.query<{ ticket_id: string; side: string; text: string; author_name: string | null; created_at: string }>(
      `select m.ticket_id, m.side, m.text, coalesce(p.full_name, u.email) as author_name, m.created_at::text
         from ticket_messages m join tickets t on t.id = m.ticket_id left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
        where m.agency_id = $1 and (t.status = 'aberto' or t.resolved_at > $2::timestamptz - interval '30 days') order by m.id`,
      [agencyId, now.toISOString()],
    ),
    slaOf(sql, agencyId),
  ]);
  const since = now.getTime() - 30 * 864e5;
  const answered = tickets.filter((t) => t.first_response_at && Date.parse(t.created_at) > since);
  const mins = (t: { created_at: string; first_response_at: string | null }) => (Date.parse(t.first_response_at!) - Date.parse(t.created_at)) / 60_000;
  const inSla = (t: { first_response_at: string | null; due_at: string }) => !!t.first_response_at && Date.parse(t.first_response_at) <= Date.parse(t.due_at);
  const people = new Map<string, { name: string; resolved: number; mins: number[]; ok: number; total: number }>();
  for (const t of tickets) {
    if (!t.assignee_user) continue;
    const p = people.get(t.assignee_user) ?? { name: t.assignee_name ?? "", resolved: 0, mins: [], ok: 0, total: 0 };
    if (t.status === "resolvido") p.resolved += 1;
    if (t.first_response_at && Date.parse(t.created_at) > since) { p.mins.push(mins(t)); p.total += 1; if (inSla(t)) p.ok += 1; }
    people.set(t.assignee_user, p);
  }
  return {
    sla,
    tickets: tickets.map((t) => ({ ...t, messages: msgs.filter((m) => m.ticket_id === t.id).map(({ ticket_id: _t, ...m }) => (void _t, m)) })),
    stats: {
      open: tickets.filter((t) => t.status === "aberto").length,
      first_response_min: answered.length ? Math.round(answered.reduce((s, t) => s + mins(t), 0) / answered.length) : null,
      in_sla_pct: answered.length ? Math.round((answered.filter(inSla).length / answered.length) * 100) : null,
    },
    people: [...people.entries()].map(([user_id, p]) => ({
      user_id, name: p.name, resolved: p.resolved, first_response_min: p.mins.length ? Math.round(p.mins.reduce((a, b) => a + b, 0) / p.mins.length) : null, in_sla_pct: p.total ? Math.round((p.ok / p.total) * 100) : null,
    })),
  };
}

/** Chamados de um cliente (portal): sem os dados internos da equipe. */
export async function clientTickets(sql: Sql, clientId: string) {
  const [tickets, msgs] = await Promise.all([
    sql.query<{ id: string; subject: string; status: string; created_at: string; resolved_at: string | null; first_response_at: string | null }>(
      `select id, subject, status, created_at::text, resolved_at::text, first_response_at::text from tickets where client_id = $1 order by (status = 'aberto') desc, created_at desc limit 100`,
      [clientId],
    ),
    sql.query<{ ticket_id: string; side: string; text: string; author_name: string | null; created_at: string }>(
      `select m.ticket_id, m.side, m.text, coalesce(p.full_name, u.email) as author_name, m.created_at::text
         from ticket_messages m join tickets t on t.id = m.ticket_id left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
        where t.client_id = $1 order by m.id`,
      [clientId],
    ),
  ]);
  return tickets.map((t) => ({ ...t, messages: msgs.filter((m) => m.ticket_id === t.id).map(({ ticket_id: _t, ...m }) => (void _t, m)) }));
}
