import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import type { Mailer } from "./email";

/**
 * Chamados das agências para o suporte do Spherum (lado da agência). A equipe responde no admin;
 * a resposta chega como aviso no app e por e-mail para quem abriu.
 */

export const supportInput = z.object({
  subject: z.string().trim().min(3).max(160),
  text: z.string().trim().min(3).max(4000),
  priority: z.enum(["alta", "media", "baixa"]).default("media"),
});

export async function listSupport(sql: Sql, agencyId: string) {
  const [tickets, msgs] = await Promise.all([
    sql.query<{ id: string; subject: string; priority: string; status: string; created_at: string; updated_at: string }>(
      `select id, subject, priority, status, created_at::text, updated_at::text from support_tickets where agency_id = $1 order by (status = 'open') desc, updated_at desc limit 50`, [agencyId]),
    sql.query<{ ticket_id: string; side: string; text: string; author: string | null; created_at: string }>(
      `select m.ticket_id, m.side, m.text, case when m.side = 'sp' then 'Suporte Spherum' else coalesce(p.full_name, u.email) end as author, m.created_at::text
         from support_messages m join support_tickets t on t.id = m.ticket_id left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
        where t.agency_id = $1 order by m.id`, [agencyId]),
  ]);
  return tickets.map((t) => ({ ...t, messages: msgs.filter((m) => m.ticket_id === t.id).map(({ ticket_id: _t, ...m }) => (void _t, m)) }));
}

export async function openSupport(sql: Sql, mail: Mailer, agencyId: string, userId: string, raw: unknown) {
  const i = supportInput.parse(raw);
  const open = await one<{ n: number }>(sql, `select count(*)::int as n from support_tickets where agency_id = $1 and status = 'open'`, [agencyId]);
  if ((open?.n ?? 0) >= 20) throw new XodoError("Vocês já têm 20 chamados abertos. Responda ou feche algum antes de abrir outro.", 429);
  const t = (await one<{ id: string }>(sql, `insert into support_tickets (agency_id, opened_by, subject, priority) values ($1, $2, $3, $4) returning id`, [agencyId, userId, i.subject, i.priority]))!;
  await sql.query(`insert into support_messages (ticket_id, side, author_user, text) values ($1, 'ag', $2, $3)`, [t.id, userId, i.text]);
  const to = process.env.SUPPORT_NOTIFY_EMAIL || process.env.LEADS_NOTIFY_EMAIL;
  if (to) {
    const a = await one<{ name: string }>(sql, `select name from agencies where id = $1`, [agencyId]);
    await mail({ to, subject: `[Suporte · ${i.priority}] ${i.subject} · ${a?.name ?? ""}`.trim(), text: `${i.text}\n\nResponda pelo admin do Spherum, em Suporte.` }).catch(() => false);
  }
  return t;
}

export async function replySupportAgency(sql: Sql, agencyId: string, userId: string, ticketId: string, raw: unknown) {
  const text = z.object({ text: z.string().trim().min(1).max(4000) }).parse(raw).text;
  const t = await one(sql, `update support_tickets set status = 'open' where id = $1 and agency_id = $2 returning id`, [ticketId, agencyId]);
  if (!t) throw new XodoError("Chamado não encontrado.", 404);
  await sql.query(`insert into support_messages (ticket_id, side, author_user, text) values ($1, 'ag', $2, $3)`, [ticketId, userId, text]);
}
