import { z } from "zod";
import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/**
 * DRE mensal da agência. Receita: faturas pagas no mês (mensalidades e avulsas) mais outras receitas
 * lançadas. Despesas: lançamentos fixos e variáveis (avulsos ou recorrentes) mais o custo dos xodós
 * (IA e computador na nuvem), que entra sozinho como variável "Xodó".
 */

const monthRe = /^\d{4}-\d{2}$/;
export const entryInput = z.object({
  kind: z.enum(["fixa", "variavel", "receita"]),
  category: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(160),
  amount: z.number().positive().max(10_000_000),
  month: z.string().regex(monthRe),
  recurring: z.boolean().default(false),
  client_id: z.uuid().nullable().optional(),
});

const first = (m: string) => `${m}-01`;
const addMonths = (m: string, n: number) => { const [y, mm] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mm - 1 + n, 1)); return d.toISOString().slice(0, 7); };

export async function addEntry(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = entryInput.parse(raw);
  if (input.client_id && !(await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [input.client_id, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
  const row = await one<{ id: string }>(
    sql,
    `insert into finance_entries (agency_id, kind, category, description, amount_cents, month, recurring, client_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [agencyId, input.kind, input.category, input.description, Math.round(input.amount * 100), first(input.month), input.recurring, input.client_id ?? null, userId],
  );
  return row!;
}

/** Apaga o lançamento; recorrente com month informado só para de repetir a partir daquele mês. */
export async function removeEntry(sql: Sql, agencyId: string, id: string, fromMonth?: string) {
  const e = await one<{ recurring: boolean; month: string }>(sql, `select recurring, to_char(month, 'YYYY-MM') as month from finance_entries where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!e) throw new XodoError("Lançamento não encontrado.", 404);
  if (e.recurring && fromMonth && monthRe.test(fromMonth) && fromMonth > e.month) {
    await sql.query(`update finance_entries set ended_month = $2 where id = $1`, [id, first(addMonths(fromMonth, -1))]);
  } else {
    await sql.query(`delete from finance_entries where id = $1`, [id]);
  }
}

export async function setTax(sql: Sql, agencyId: string, pct: number) {
  const v = z.number().min(0).max(40).parse(pct);
  await sql.query(`update agencies set dre_tax_pct = $2 where id = $1`, [agencyId, v]);
}

/** DRE dos últimos N meses (o atual por último), no fuso de São Paulo. */
export async function dreReport(sql: Sql, agencyId: string, months = 3, now = new Date()) {
  const cur = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
  const keys = Array.from({ length: months }, (_, i) => addMonths(cur, i - months + 1));
  const from = first(keys[0]), to = first(addMonths(cur, 1));
  const [tax, paid, entries, ai, pc] = await Promise.all([
    one<{ dre_tax_pct: number }>(sql, `select dre_tax_pct::float8 as dre_tax_pct from agencies where id = $1`, [agencyId]),
    sql.query<{ m: string; recurring: boolean; cents: number }>(
      `select to_char(paid_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as m, recurrence_id is not null as recurring, sum(coalesce(paid_cents, amount_cents))::float8 as cents
         from invoices where agency_id = $1 and status = 'pago' and paid_at >= ($2::date::timestamp at time zone 'America/Sao_Paulo') and paid_at < ($3::date::timestamp at time zone 'America/Sao_Paulo') group by 1, 2`,
      [agencyId, from, to],
    ),
    sql.query<{ id: string; kind: string; category: string; description: string; amount_cents: number; month: string; recurring: boolean; ended_month: string | null }>(
      `select id, kind, category, description, amount_cents::float8 as amount_cents, to_char(month, 'YYYY-MM') as month, recurring, to_char(ended_month, 'YYYY-MM') as ended_month
         from finance_entries where agency_id = $1 and month < $2::date and (month >= $3::date or recurring) order by created_at`,
      [agencyId, to, from],
    ),
    sql.query<{ m: string; brl: number }>(
      `select to_char(day, 'YYYY-MM') as m, coalesce(sum(cost_brl), 0)::float8 as brl from ai_usage where agency_id = $1 and day >= $2::date and day < $3::date group by 1`,
      [agencyId, from, to],
    ),
    sql.query<{ m: string; brl: number }>(
      `select to_char(started_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as m, coalesce(sum(cost_brl), 0)::float8 as brl from computer_sessions where agency_id = $1 and started_at >= ($2::date::timestamp at time zone 'America/Sao_Paulo') and started_at < ($3::date::timestamp at time zone 'America/Sao_Paulo') group by 1`,
      [agencyId, from, to],
    ),
  ]);
  const taxPct = num(tax?.dre_tax_pct ?? 6);
  const out = keys.map((m) => {
    const fees = paid.filter((p) => p.m === m && p.recurring).reduce((s, p) => s + num(p.cents), 0) / 100;
    const avulsos = paid.filter((p) => p.m === m && !p.recurring).reduce((s, p) => s + num(p.cents), 0) / 100;
    const live = entries.filter((e) => (e.recurring ? e.month <= m && (!e.ended_month || e.ended_month >= m) : e.month === m));
    const outras = live.filter((e) => e.kind === "receita").reduce((s, e) => s + e.amount_cents, 0) / 100;
    const gross = fees + avulsos + outras;
    const taxV = Math.round(gross * taxPct) / 100;
    const xodo = Math.round(((ai.find((a) => a.m === m)?.brl ?? 0) + (pc.find((a) => a.m === m)?.brl ?? 0)) * 100) / 100;
    const items = live.filter((e) => e.kind !== "receita").map((e) => ({ id: e.id, kind: e.kind === "fixa" ? "fix" : "var", category: e.category, description: e.description, value: e.amount_cents / 100, recurring: e.recurring, auto: false }));
    if (xodo > 0) items.push({ id: `xodo-${m}`, kind: "var", category: "Xodó", description: "IA e computador dos xodós (automático)", value: xodo, recurring: false, auto: true });
    const vari = items.filter((i) => i.kind === "var").reduce((s, i) => s + i.value, 0), fixa = items.filter((i) => i.kind === "fix").reduce((s, i) => s + i.value, 0);
    const net = gross - taxV, contrib = net - vari, result = contrib - fixa;
    return { month: m, fees, avulsos, outras, gross, tax: taxV, net, variable: vari, fixed: fixa, contrib, result, margin: gross ? (result / gross) * 100 : 0,
      revenue_entries: live.filter((e) => e.kind === "receita").map((e) => ({ id: e.id, category: e.category, description: e.description, value: e.amount_cents / 100, recurring: e.recurring })), items };
  });
  return { tax_pct: taxPct, months: out };
}
