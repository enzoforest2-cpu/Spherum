import { z } from "zod";
import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/**
 * Rentabilidade por cliente nos últimos 30 dias: mensalidade (contrato em vigor ou a do cliente)
 * menos as horas da equipe (custo por hora da agência) e a parte do custo dos xodós (rateada pelas
 * ações executadas em cada cliente). Horas economizadas pelos xodós: estimativa de 10 min por ação.
 */

export const CATEGORIES = ["trafego", "criativos", "reunioes", "relatorios", "outros"] as const;
export const MINUTES_PER_ACTION = 10;

export const timeInput = z.object({
  client_id: z.uuid().nullable().optional(),
  project_id: z.uuid().nullable().optional(),
  category: z.enum(CATEGORIES).default("outros"),
  minutes: z.number().int().min(1).max(1440),
  day: z.iso.date(),
  note: z.string().trim().max(300).optional(),
});

export async function logTime(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = timeInput.parse(raw);
  if (input.client_id && !(await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [input.client_id, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
  let clientId = input.client_id ?? null;
  if (input.project_id) {
    const p = await one<{ client_id: string | null }>(sql, `select client_id from projects where id = $1 and agency_id = $2`, [input.project_id, agencyId]);
    if (!p) throw new XodoError("Projeto não encontrado.", 404);
    clientId = clientId ?? p.client_id;
  }
  return (await one<{ id: string }>(
    sql,
    `insert into time_entries (agency_id, user_id, client_id, project_id, category, minutes, day, note) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [agencyId, userId, clientId, input.project_id ?? null, input.category, input.minutes, input.day, input.note ?? null],
  ))!;
}

export async function deleteTime(sql: Sql, agencyId: string, userId: string, id: string, canManage: boolean) {
  const r = await one(sql, `delete from time_entries where id = $1 and agency_id = $2 and ($3 or user_id = $4) returning id`, [id, agencyId, canManage, userId]);
  if (!r) throw new XodoError("Registro não encontrado.", 404);
}

export async function setCostPerHour(sql: Sql, agencyId: string, value: number) {
  const v = z.number().min(10).max(2000).parse(value);
  await sql.query(`update agencies set cost_per_hour = $2 where id = $1`, [agencyId, v]);
}

export async function profitBoard(sql: Sql, agencyId: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10);
  const [agency, clients, hours, actions, ai, mine] = await Promise.all([
    one<{ cost_per_hour: number }>(sql, `select cost_per_hour::float8 as cost_per_hour from agencies where id = $1`, [agencyId]),
    sql.query<{ id: string; name: string; fee: number }>(
      `select c.id, c.name, coalesce(k.monthly_fee_cents, c.monthly_fee_cents, 0)::float8 / 100 as fee
         from clients c left join client_contracts k on k.client_id = c.id and k.status <> 'encerrado'
        where c.agency_id = $1 and c.archived_at is null order by c.name`,
      [agencyId],
    ),
    sql.query<{ client_id: string; category: string; minutes: number }>(
      `select client_id, category, sum(minutes)::int as minutes from time_entries where agency_id = $1 and client_id is not null and day >= $2::date group by 1, 2`,
      [agencyId, since],
    ),
    sql.query<{ client_id: string; n: number }>(
      `select input->>'client_id' as client_id, count(*)::int as n from xodo_actions
        where agency_id = $1 and status = 'executed' and executed_at >= $2::date and input ? 'client_id' group by 1`,
      [agencyId, since],
    ),
    one<{ brl: number }>(sql, `select coalesce(sum(cost_brl), 0)::float8 as brl from ai_usage where agency_id = $1 and day >= $2::date`, [agencyId, since]),
    sql.query<{ id: string; client_name: string | null; category: string; minutes: number; day: string; note: string | null; user_id: string; user_name: string | null }>(
      `select t.id, c.name as client_name, t.category, t.minutes, t.day::text, t.note, t.user_id, coalesce(p.full_name, u.email) as user_name
         from time_entries t left join clients c on c.id = t.client_id left join profiles p on p.id = t.user_id left join auth.users u on u.id = t.user_id
        where t.agency_id = $1 and t.day >= $2::date order by t.day desc, t.created_at desc limit 200`,
      [agencyId, since],
    ),
  ]);
  const cph = num(agency?.cost_per_hour ?? 85), totalActions = actions.reduce((s, a) => s + a.n, 0), aiTotal = num(ai?.brl ?? 0);
  const rows = clients.map((c) => {
    const hs = hours.filter((h) => h.client_id === c.id), minutes = hs.reduce((s, h) => s + h.minutes, 0), acts = actions.find((a) => a.client_id === c.id)?.n ?? 0;
    const h = Math.round((minutes / 60) * 10) / 10, cost = h * cph, xodo = totalActions ? Math.round((aiTotal * acts) / totalActions * 100) / 100 : 0, margin = c.fee - cost - xodo;
    return { client_id: c.id, name: c.name, fee: c.fee, hours: h, cost, xodo_cost: xodo, margin, margin_pct: c.fee ? (margin / c.fee) * 100 : null,
      saved_hours: Math.round((acts * MINUTES_PER_ACTION) / 60 * 10) / 10, split: CATEGORIES.map((k) => ({ category: k, hours: Math.round(((hs.find((x) => x.category === k)?.minutes ?? 0) / 60) * 10) / 10 })) };
  });
  return { cost_per_hour: cph, rows, entries: mine, logged_hours: Math.round((rows.reduce((s, r) => s + r.hours, 0)) * 10) / 10 };
}
