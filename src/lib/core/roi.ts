import { z } from "zod";
import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { createUpdate } from "./collab";

/**
 * Retorno: o investimento em anúncio (metrics_daily) contra as vendas de verdade do cliente
 * (client_sales). Venda ligada a uma campanha entra no retorno da campanha; as outras contam no
 * total do mês. O que a plataforma diz (conversões e receita atribuídas) aparece para comparar.
 */

const TZ = "America/Sao_Paulo";
const MN = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const brl = (cents: number) => `R$ ${Math.round(cents / 100).toLocaleString("pt-BR")}`;

export const saleInput = z.object({
  sold_on: z.iso.date(),
  amount: z.number().positive().max(1_000_000_000),
  customer: z.string().trim().max(160).nullable().optional(),
  campaign_id: z.string().trim().max(120).nullable().optional(),
  lead_on: z.iso.date().nullable().optional(),
  external_id: z.string().trim().max(120).nullable().optional(),
});

async function clientOf(sql: Sql, agencyId: string, clientId: string) {
  if (!(await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [clientId, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
}

async function campaignName(sql: Sql, clientId: string, campaignId: string | null | undefined) {
  if (!campaignId) return null;
  const r = await one<{ campaign_name: string | null }>(sql, `select campaign_name from metrics_daily where client_id = $1 and campaign_id = $2 order by day desc limit 1`, [clientId, campaignId]);
  if (!r) throw new XodoError("Campanha não encontrada neste cliente.", 400);
  return r.campaign_name;
}

/** Lança uma venda (agência ou cliente pelo portal). Mesma venda com o mesmo código não entra duas vezes. */
export async function addSale(sql: Sql, agencyId: string, clientId: string, userId: string, source: "manual" | "planilha" | "portal" | "crm", raw: unknown) {
  const i = saleInput.parse(raw);
  await clientOf(sql, agencyId, clientId);
  if (i.lead_on && i.lead_on > i.sold_on) throw new XodoError("O lead não pode ser depois da venda.", 400);
  const name = await campaignName(sql, clientId, i.campaign_id);
  const row = await one<{ id: string }>(
    sql,
    `insert into client_sales (agency_id, client_id, sold_on, amount_cents, customer, campaign_id, campaign_name, lead_on, source, external_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (client_id, external_id) where external_id is not null do nothing returning id`,
    [agencyId, clientId, i.sold_on, Math.round(i.amount * 100), i.customer ?? null, i.campaign_id || null, name, i.lead_on ?? null, source, i.external_id || null, userId],
  );
  await sql.query(`update clients set sales_source = coalesce(sales_source, $2) where id = $1`, [clientId, source]);
  return { id: row?.id ?? null, duplicate: !row };
}

/** Importa uma planilha (já lida no navegador): devolve quantas entraram, repetidas e com erro. */
export async function importSales(sql: Sql, agencyId: string, clientId: string, userId: string, rows: unknown[]) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new XodoError("Mande de 1 a 5.000 vendas.", 400);
  await clientOf(sql, agencyId, clientId);
  let added = 0, duplicate = 0;
  const errors: { line: number; error: string }[] = [];
  for (const [n, r] of rows.entries()) {
    try {
      const out = await addSale(sql, agencyId, clientId, userId, "planilha", r);
      if (out.duplicate) duplicate++; else added++;
    } catch (error) {
      errors.push({ line: n + 1, error: error instanceof z.ZodError ? "dados incompletos (data e valor)" : error instanceof Error ? error.message : String(error) });
    }
  }
  return { added, duplicate, errors: errors.slice(0, 20), failed: errors.length };
}

export async function deleteSale(sql: Sql, agencyId: string, id: string) {
  const r = await one(sql, `delete from client_sales where id = $1 and agency_id = $2 returning id`, [id, agencyId]);
  if (!r) throw new XodoError("Venda não encontrada.", 404);
}

const monthOf = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ }).slice(0, 7);
const shift = (month: string, n: number) => { const [y, m] = month.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const endOf = (month: string) => shift(month, 1) + "-01";

/** O retorno do cliente no mês: totais, funil, campanhas, últimas vendas e os 6 meses anteriores. */
export async function roiReport(sql: Sql, agencyId: string, clientId: string, month?: string, now = new Date()) {
  await clientOf(sql, agencyId, clientId);
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : shift(monthOf(now), -1);
  const from = `${m}-01`, to = endOf(m), histFrom = `${shift(m, -5)}-01`;
  const [client, camps, sales, hist, histSales, recent] = await Promise.all([
    one<{ name: string; sales_source: string | null }>(sql, `select name, sales_source from clients where id = $1`, [clientId]),
    sql.query<{ campaign_id: string; campaign_name: string | null; spend: number; clicks: number; leads: number; conversions: number; revenue: number }>(
      `select campaign_id, max(campaign_name) as campaign_name, sum(spend_cents)::float8 as spend, sum(clicks)::float8 as clicks, sum(leads)::float8 as leads,
              sum(conversions)::float8 as conversions, sum(revenue_cents)::float8 as revenue
         from metrics_daily where client_id = $1 and day >= $2 and day < $3 group by campaign_id order by 4 desc`,
      [clientId, from, to],
    ),
    sql.query<{ campaign_id: string | null; n: number; amount: number }>(
      `select campaign_id, count(*)::int as n, sum(amount_cents)::float8 as amount from client_sales where client_id = $1 and sold_on >= $2 and sold_on < $3 group by campaign_id`,
      [clientId, from, to],
    ),
    sql.query<{ month: string; spend: number }>(
      `select to_char(day, 'YYYY-MM') as month, sum(spend_cents)::float8 as spend from metrics_daily where client_id = $1 and day >= $2 and day < $3 group by 1`,
      [clientId, histFrom, to],
    ),
    sql.query<{ month: string; amount: number }>(
      `select to_char(sold_on, 'YYYY-MM') as month, sum(amount_cents)::float8 as amount from client_sales where client_id = $1 and sold_on >= $2 and sold_on < $3 group by 1`,
      [clientId, histFrom, to],
    ),
    sql.query<{ id: string; sold_on: string; amount_cents: number; customer: string | null; campaign_name: string | null; lead_on: string | null; source: string }>(
      `select id, sold_on::text, amount_cents::float8 as amount_cents, customer, campaign_name, lead_on::text, source from client_sales
        where client_id = $1 and sold_on < $2 order by sold_on desc, created_at desc limit 20`,
      [clientId, to],
    ),
  ]);
  const spend = camps.reduce((t, c) => t + num(c.spend), 0);
  const total = { n: sales.reduce((t, s) => t + s.n, 0), amount: sales.reduce((t, s) => t + num(s.amount), 0) };
  const linked = sales.filter((s) => s.campaign_id).reduce((t, s) => t + s.n, 0);
  const sum = (k: "clicks" | "leads" | "conversions" | "revenue") => camps.reduce((t, c) => t + num(c[k]), 0);
  const leads = sum("leads"), clicks = sum("clicks"), platformRevenue = sum("revenue");
  const ecom = platformRevenue > 0 && leads === 0;
  const cycles = recent.filter((r) => r.lead_on).map((r) => (Date.parse(r.sold_on) - Date.parse(r.lead_on!)) / 864e5);
  return {
    client: client!.name, month: m, month_label: MN[Number(m.slice(5)) - 1], source: client!.sales_source,
    spend_cents: spend, sales: total.n, revenue_cents: total.amount,
    roi: spend ? total.amount / spend : null, cost_per_sale_cents: total.n ? spend / total.n : null,
    ecom, top: ecom ? { label: "Cliques", value: clicks } : { label: "Leads", value: leads },
    platform: { conversions: sum("conversions"), revenue_cents: platformRevenue, roas: spend && platformRevenue ? platformRevenue / spend : null, cpl_cents: leads ? spend / leads : null },
    match_pct: total.n ? Math.round((linked / total.n) * 100) : null,
    cycle_days: cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null,
    campaigns: camps.map((c) => {
      const s = sales.find((x) => x.campaign_id === c.campaign_id);
      return { id: c.campaign_id, name: c.campaign_name || c.campaign_id || "Sem campanha", spend_cents: num(c.spend), leads: num(c.leads), clicks: num(c.clicks), sales: s?.n ?? 0, revenue_cents: num(s?.amount ?? 0) };
    }),
    history: Array.from({ length: 6 }, (_, i) => { const mm = shift(m, i - 5); return { month: mm, spend_cents: num(hist.find((h) => h.month === mm)?.spend ?? 0), revenue_cents: num(histSales.find((h) => h.month === mm)?.amount ?? 0) }; }),
    recent: recent.map((r) => ({ ...r, amount_cents: num(r.amount_cents) })),
  };
}

/** Resumo do retorno do mês vai para o portal do cliente (em "Feito pela agência"). */
export async function publishRoi(sql: Sql, agencyId: string, userId: string, clientId: string, month?: string, now = new Date()) {
  const r = await roiReport(sql, agencyId, clientId, month, now);
  if (!r.spend_cents && !r.sales) throw new XodoError("Sem investimento nem vendas nesse mês.", 400);
  const x = r.roi ? r.roi.toFixed(2).replace(".", ",") : "—";
  return createUpdate(sql, agencyId, userId, clientId, {
    title: `Retorno de ${r.month_label}: cada R$ 1 em anúncio virou R$ ${x} em vendas`.slice(0, 160),
    why: `${brl(r.revenue_cents)} em ${r.sales} venda${r.sales === 1 ? "" : "s"} com ${brl(r.spend_cents)} de anúncio${r.cost_per_sale_cents ? ` (custo por venda: ${brl(r.cost_per_sale_cents)})` : ""}.`,
    kind: "relatorio",
    impact: r.roi ? `Retorno ${x}x` : undefined,
    publish: true,
  });
}

/** Quanto cada cliente vendeu no mês e o retorno (para a lista de clientes). */
export async function roiOverview(sql: Sql, agencyId: string, month: string) {
  const to = endOf(month);
  return sql.query<{ client_id: string; sales_source: string | null; spend: number; revenue: number }>(
    `select c.id as client_id, c.sales_source,
            coalesce((select sum(spend_cents) from metrics_daily m where m.client_id = c.id and m.day >= $2::date and m.day < $3::date), 0)::float8 as spend,
            coalesce((select sum(amount_cents) from client_sales s where s.client_id = c.id and s.sold_on >= $2::date and s.sold_on < $3::date), 0)::float8 as revenue
       from clients c where c.agency_id = $1`,
    [agencyId, `${month}-01`, to],
  );
}
