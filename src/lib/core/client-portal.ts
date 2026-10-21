import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { listClientInvoices } from "../billing";
import { clientCollab } from "./collab";
import { listSharedDocuments } from "./documents";

/**
 * Dados do portal do cliente (design/project/spherum/cliente_tpl.html): o que a agência fez
 * pelo cliente, em números. Quem entra é alguém do cliente (client_portal_users) ou alguém da
 * agência conferindo o que o cliente vê. Só relatórios publicados aparecem.
 */

const PLATFORM_LABEL: Record<string, string> = { meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads", linkedin: "LinkedIn Ads", other: "Outra" };

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export type Totals = { spend: number; results: number; revenue: number; clicks: number; impressions: number };
const zero = (): Totals => ({ spend: 0, results: 0, revenue: 0, clicks: 0, impressions: 0 });

/** Quem pode ver o portal deste cliente: a própria pessoa do cliente ou a equipe da agência. */
export async function clientAccess(sql: Sql, userId: string, clientId: string) {
  const row = await one<{ agency_id: string; portal: boolean; member: boolean }>(
    sql,
    `select c.agency_id,
            exists (select 1 from client_portal_users u where u.client_id = c.id and u.user_id = $2) as portal,
            exists (select 1 from agency_members m where m.agency_id = c.agency_id and m.user_id = $2) as member
       from clients c where c.id = $1 and c.archived_at is null`,
    [clientId, userId],
  );
  if (!row || (!row.portal && !row.member)) throw new XodoError("Não encontrado", 404);
  return { agencyId: row.agency_id, as: row.portal ? ("cliente" as const) : ("agencia" as const) };
}

export async function clientPortal(sql: Sql, clientId: string, userId: string, now = new Date()) {
  const access = await clientAccess(sql, userId, clientId);
  const end = addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), -1);
  const to = day(end);
  const since = (n: number) => day(addDays(end, -(n - 1)));

  const [client, me, dailyRows, campRows, reportRows, documents, invoices, paysOnline, collab] = await Promise.all([
    one<{ name: string; goal_metric: string | null; goal_value: number | null; agency: string; brand_color: string | null; owner: string | null; owner_email: string | null }>(
      sql,
      `select c.name, c.goal_metric, c.goal_value::float8 as goal_value, a.name as agency, a.brand_color, p.full_name as owner, u.email as owner_email
         from clients c join agencies a on a.id = c.agency_id
         left join profiles p on p.id = c.owner_user_id left join auth.users u on u.id = c.owner_user_id
        where c.id = $1`,
      [clientId],
    ),
    one<{ full_name: string | null; email: string | null }>(sql, `select p.full_name, u.email from auth.users u left join profiles p on p.id = u.id where u.id = $1`, [userId]),
    sql.query<{ day: string; platform: string } & Totals>(
      `select day::text, platform, sum(spend_cents)::float8 / 100 as spend, sum(leads + conversions)::float8 as results,
              sum(revenue_cents)::float8 / 100 as revenue, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions
         from metrics_daily where client_id = $1 and platform <> 'ga4' and day between $2::date and $3::date
        group by day, platform order by day`,
      [clientId, since(180), to],
    ),
    sql.query<{ platform: string; campaign_id: string; name: string | null; recent: number; win: string } & Totals>(
      `select platform, campaign_id, max(campaign_name) as name, case when day >= $3::date then '30' else '90' end as win,
              sum(spend_cents)::float8 / 100 as spend, sum(leads + conversions)::float8 as results, sum(revenue_cents)::float8 / 100 as revenue,
              sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
              coalesce(sum(spend_cents) filter (where day > $4::date - 3), 0)::float8 / 100 as recent
         from metrics_daily where client_id = $1 and platform <> 'ga4' and day between $2::date and $4::date
        group by platform, campaign_id, win`,
      [clientId, since(90), since(30), to],
    ),
    sql.query<{ id: string; title: string; period_start: string; period_end: string; published_at: string; body_md: string }>(
      `select id, title, period_start::text, period_end::text, published_at::text, body_md from reports
        where client_id = $1 and status = 'published' order by period_end desc, published_at desc limit 24`,
      [clientId],
    ),
    listSharedDocuments(sql, clientId),
    listClientInvoices(sql, clientId),
    one<{ ok: boolean }>(sql, `select exists (select 1 from payment_accounts p join clients c on c.agency_id = p.agency_id where c.id = $1) as ok`, [clientId]),
    clientCollab(sql, clientId, "cliente"),
  ]);

  // Totais das janelas de 30 e 90 dias (e das anteriores, para comparar) e por plataforma.
  const windows = { d30: { cur: zero(), prev: zero() }, d90: { cur: zero(), prev: zero() } };
  const plat = new Map<string, { d30: Totals; d90: Totals }>();
  const add = (t: Totals, r: Totals) => {
    t.spend += num(r.spend);
    t.results += num(r.results);
    t.revenue += num(r.revenue);
    t.clicks += num(r.clicks);
    t.impressions += num(r.impressions);
  };
  const byDay = new Map<string, Totals>();
  for (const r of dailyRows) {
    const d = byDay.get(r.day) ?? zero();
    add(d, r);
    byDay.set(r.day, d);
    const p = plat.get(r.platform) ?? { d30: zero(), d90: zero() };
    if (r.day >= since(30)) { add(windows.d30.cur, r); add(p.d30, r); }
    else if (r.day >= since(60)) add(windows.d30.prev, r);
    if (r.day >= since(90)) { add(windows.d90.cur, r); add(p.d90, r); }
    else add(windows.d90.prev, r);
    plat.set(r.platform, p);
  }

  const camps = new Map<string, { name: string; plat: string; live: boolean; d30: Totals; d90: Totals }>();
  for (const r of campRows) {
    const key = `${r.platform}:${r.campaign_id}`;
    const c = camps.get(key) ?? { name: r.name || r.campaign_id || "Campanha", plat: PLATFORM_LABEL[r.platform] ?? r.platform, live: false, d30: zero(), d90: zero() };
    if (num(r.recent) > 0) c.live = true;
    if (r.win === "30") add(c.d30, r);
    add(c.d90, r);
    camps.set(key, c);
  }

  return {
    as: access.as,
    client: { id: clientId, name: client!.name, goal_metric: client!.goal_metric, goal_value: client!.goal_value },
    agency: { name: client!.agency, brand_color: client!.brand_color },
    owner: client!.owner ? { name: client!.owner, email: client!.owner_email } : null,
    me: { name: me?.full_name || me?.email || "" },
    period: { to },
    totals: windows,
    daily: [...byDay.entries()].map(([d, t]) => ({ day: d, spend: t.spend, conv: t.results, rev: t.revenue })),
    channels: [...plat.entries()]
      .sort((a, b) => b[1].d90.spend - a[1].d90.spend)
      .map(([p, t]) => ({ label: PLATFORM_LABEL[p] ?? p, d30: t.d30, d90: t.d90 })),
    camps: [...camps.values()].sort((a, b) => b.d90.spend - a.d90.spend).slice(0, 30),
    reports: reportRows,
    documents,
    invoices,
    paysOnline: !!paysOnline?.ok,
    collab,
  };
}
