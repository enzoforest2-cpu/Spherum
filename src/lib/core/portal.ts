import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { listConnections } from "../integrations/store";
import { listDocuments } from "./documents";

/**
 * Dados do portal da agência no formato que as telas do design usam (o data() do
 * design/project/spherum/agencia_tpl.html). Só o núcleo vem daqui: clientes, campanhas,
 * performance, relatórios, equipe, integrações e avisos. O resto do portal continua com os
 * exemplos do design até cada módulo ganhar backend.
 */

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const PLATFORM_LABEL: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", linkedin: "LinkedIn", ga4: "GA4", other: "Outra" };
const ROLE_LABEL: Record<string, string> = { owner: "Proprietário", admin: "Admin", member: "Membro", viewer: "Leitor" };

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => w.length > 2);
  return (words.length ? words : name.split(/\s+/)).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/** "há 40 min", "há 3 h", "ontem", "há 5 d", "12 mar 2025". */
export function relative(at: Date | string | null, now: Date): string {
  if (!at) return "—";
  const t = new Date(at);
  const min = Math.round((now.getTime() - t.getTime()) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return "ontem";
  if (d < 30) return `há ${d} d`;
  return `${String(t.getUTCDate()).padStart(2, "0")} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

export const monthYear = (at: Date | string | null) => {
  if (!at) return "—";
  const t = new Date(typeof at === "string" && at.length === 10 ? `${at}T12:00:00Z` : at);
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
};

type Totals = { spend: number; results: number; revenue: number };
const zero = (): Totals => ({ spend: 0, results: 0, revenue: 0 });

/** Valor atual da meta: CPL/CPA = gasto ÷ resultados; ROAS = receita ÷ gasto. Nulo sem dados. */
export function goalValue(metric: string | null, t: Totals): number | null {
  if (metric === "ROAS") return t.spend > 0 ? Math.round((t.revenue / t.spend) * 100) / 100 : null;
  return t.results > 0 ? Math.round((t.spend / t.results) * 100) / 100 : null;
}

/** Quanto pior que a meta (positivo = pior), em %. */
export function goalGap(metric: string | null, goal: number | null, current: number | null): number | null {
  if (!metric || !goal || current === null) return null;
  return metric === "ROAS" ? ((goal - current) / goal) * 100 : ((current - goal) / goal) * 100;
}

export async function agencyPortal(sql: Sql, agencyId: string, userId: string, now = new Date()) {
  const agency = await one<{ name: string; plan: string; plan_status: string; trial_ends_at: string | null; brand_color: string | null }>(
    sql,
    `select name, plan, plan_status, trial_ends_at::text, brand_color from agencies where id = $1`,
    [agencyId],
  );
  if (!agency) throw new XodoError("Não encontrado", 404);
  const end = addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), -1);
  const cur = { from: day(addDays(end, -29)), to: day(end) };
  const prev = { from: day(addDays(end, -59)), to: day(addDays(end, -30)) };

  const [me, clientRows, metricRows, campRows, dailyRows, clientDailyRows, reportRows, memberRows, inviteRows, connections, accounts, pending, documents] = await Promise.all([
    one<{ full_name: string | null; role: string; email: string | null }>(
      sql,
      `select p.full_name, m.role, u.email from agency_members m left join profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id
        where m.agency_id = $1 and m.user_id = $2`,
      [agencyId, userId],
    ),
    sql.query<{
      id: string; name: string; segment: string | null; status: string; monthly_fee: number | null; started_on: string | null; created_at: string;
      updated_at: string; owner_name: string | null; goal_metric: string | null; goal_value: number | null; health_score: number | null;
      health_reason: string | null; contact: string | null;
    }>(
      `select c.id, c.name, c.segment, c.status, c.monthly_fee_cents::float8 / 100 as monthly_fee, c.started_on::text, c.created_at::text,
              c.updated_at::text, op.full_name as owner_name, c.goal_metric, c.goal_value::float8 as goal_value, c.health_score, c.health_reason,
              (select ct.name from client_contacts ct where ct.client_id = c.id order by ct.is_primary desc, ct.created_at limit 1) as contact
         from clients c left join profiles op on op.id = c.owner_user_id
        where c.agency_id = $1 and c.archived_at is null order by lower(c.name)`,
      [agencyId],
    ),
    sql.query<{ client_id: string; win: string; spend: number; results: number; revenue: number }>(
      `select client_id, case when day >= $2::date then 'cur' else 'prev' end as win,
              sum(spend_cents)::float8 / 100 as spend, sum(leads + conversions)::float8 as results, sum(revenue_cents)::float8 / 100 as revenue
         from metrics_daily where agency_id = $1 and platform <> 'ga4' and day between $3::date and $4::date
        group by client_id, win`,
      [agencyId, cur.from, prev.from, cur.to],
    ),
    sql.query<{ client_id: string; platform: string; campaign_id: string; name: string | null; spend: number; results: number; revenue: number; recent: number }>(
      `select client_id, platform, campaign_id, max(campaign_name) as name, sum(spend_cents)::float8 / 100 as spend,
              sum(leads + conversions)::float8 as results, sum(revenue_cents)::float8 / 100 as revenue,
              sum(spend_cents) filter (where day > $3::date - 3)::float8 / 100 as recent
         from metrics_daily where agency_id = $1 and platform <> 'ga4' and day between $2::date and $3::date
        group by client_id, platform, campaign_id order by sum(spend_cents) desc limit 300`,
      [agencyId, cur.from, cur.to],
    ),
    sql.query<{ day: string; platform: string; spend: number; results: number; revenue: number }>(
      `select day::text, platform, sum(spend_cents)::float8 / 100 as spend, sum(leads + conversions)::float8 as results,
              sum(revenue_cents)::float8 / 100 as revenue
         from metrics_daily where agency_id = $1 and platform <> 'ga4' and day > $2::date - 365 and day <= $2::date
        group by day, platform order by day`,
      [agencyId, cur.to],
    ),
    sql.query<{ client_id: string; day: string; spend: number; results: number; revenue: number }>(
      `select client_id, day::text, sum(spend_cents)::float8 / 100 as spend, sum(leads + conversions)::float8 as results,
              sum(revenue_cents)::float8 / 100 as revenue
         from metrics_daily where agency_id = $1 and platform <> 'ga4' and day between $2::date and $3::date
        group by client_id, day order by day`,
      [agencyId, prev.from, cur.to],
    ),
    sql.query<{ id: string; client_id: string; title: string; status: string; period_start: string; period_end: string; published_at: string | null; created_at: string; by_xodo: string | null }>(
      `select r.id, r.client_id, r.title, r.status, r.period_start::text, r.period_end::text, r.published_at::text, r.created_at::text, x.name as by_xodo
         from reports r left join xodos x on x.id = r.created_by_xodo
        where r.agency_id = $1 and r.status <> 'archived' order by r.created_at desc limit 100`,
      [agencyId],
    ),
    sql.query<{ user_id: string; role: string; title: string | null; full_name: string | null; email: string | null; clients: number }>(
      `select m.user_id, m.role, m.title, p.full_name, u.email,
              (select count(*)::int from clients c where c.agency_id = m.agency_id and c.owner_user_id = m.user_id and c.archived_at is null) as clients
         from agency_members m left join profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id
        where m.agency_id = $1
        order by case m.role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end, m.created_at`,
      [agencyId],
    ),
    sql.query<{ id: string; email: string; role: string; kind: string; expires_at: string }>(
      `select id, email, role, kind, expires_at::text from invites
        where agency_id = $1 and accepted_at is null and revoked_at is null and expires_at > $2::timestamptz order by created_at desc`,
      [agencyId, now.toISOString()],
    ),
    listConnections(sql, agencyId),
    sql.query<{ id: string; client_id: string; platform: string; external_id: string; name: string | null; last_synced_at: string | null; last_sync_error: string | null }>(
      `select id, client_id, platform, external_id, name, last_synced_at::text, last_sync_error from client_ad_accounts where agency_id = $1 order by platform, name`,
      [agencyId],
    ),
    one<{ n: number }>(sql, `select count(*)::int as n from xodo_actions where agency_id = $1 and status = 'pending'`, [agencyId]),
    listDocuments(sql, agencyId),
  ]);

  const totals = new Map<string, { cur: Totals; prev: Totals }>();
  for (const r of metricRows) {
    const t = totals.get(r.client_id) ?? { cur: zero(), prev: zero() };
    const w = r.win === "cur" ? t.cur : t.prev;
    w.spend += num(r.spend);
    w.results += num(r.results);
    w.revenue += num(r.revenue);
    totals.set(r.client_id, t);
  }
  const accountsByClient = new Map<string, typeof accounts>();
  for (const a of accounts) accountsByClient.set(a.client_id, [...(accountsByClient.get(a.client_id) ?? []), a]);

  const clients = clientRows.map((c) => {
    const t = totals.get(c.id) ?? { cur: zero(), prev: zero() };
    const gt = c.goal_metric ?? "CPL";
    const curValue = goalValue(gt, t.cur);
    const gap = goalGap(c.goal_metric, c.goal_value, curValue);
    const reasons: string[] = [];
    if (gap !== null && gap > 0) reasons.push(`${gt} ${Math.round(gap)}% ${gt === "ROAS" ? "abaixo" : "acima"} da meta`);
    const accts = accountsByClient.get(c.id) ?? [];
    if (!accts.length) reasons.push("Nenhuma conta de anúncio ligada");
    else if (accts.some((a) => a.last_sync_error)) reasons.push("Erro ao sincronizar uma conta de anúncio");
    if (!c.goal_metric) reasons.push("Meta de CPL, CPA ou ROAS não definida");
    return {
      id: c.id,
      name: c.name,
      seg: c.segment ?? "",
      owner: c.owner_name ?? "",
      mrr: num(c.monthly_fee),
      health: c.health_score,
      gt,
      goal: c.goal_value,
      cur: c.goal_metric && c.goal_value ? curValue : null,
      projects: 0,
      fin: "Em dia",
      last: relative(c.updated_at, now),
      since: monthYear(c.started_on ?? c.created_at),
      renew: "—",
      meet: 0,
      reasons,
      contact: c.contact ?? "",
      ini: initials(c.name),
      status: c.status,
      spend30: Math.round(t.cur.spend * 100) / 100,
    };
  });
  const goalOf = new Map(clientRows.map((c) => [c.id, c.goal_metric !== "ROAS" ? c.goal_value : null]));

  const camps = campRows.map((r, i) => {
    const spend = num(r.spend);
    const conv = num(r.results);
    const cpa = conv > 0 ? spend / conv : 0;
    const target = goalOf.get(r.client_id) ?? cpa;
    return {
      id: i,
      name: r.name || r.campaign_id || "Campanha",
      client: r.client_id,
      plat: PLATFORM_LABEL[r.platform] ?? r.platform,
      status: num(r.recent) > 0 ? "Ativa" : "Pausada",
      spend,
      conv,
      target,
      rev: num(r.revenue) > 0 ? num(r.revenue) : null,
      seed: 11 + i,
      cpa,
    };
  });

  const platMap = new Map<string, Totals>();
  const dailyMap = new Map<string, Totals>();
  for (const r of dailyRows) {
    const d = dailyMap.get(r.day) ?? zero();
    d.spend += num(r.spend);
    d.results += num(r.results);
    d.revenue += num(r.revenue);
    dailyMap.set(r.day, d);
    if (r.day >= cur.from) {
      const p = platMap.get(r.platform) ?? zero();
      p.spend += num(r.spend);
      p.results += num(r.results);
      p.revenue += num(r.revenue);
      platMap.set(r.platform, p);
    }
  }
  const plat = [...platMap.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .map(([p, t]) => [PLATFORM_LABEL[p] ?? p, Math.round(t.spend * 100) / 100, t.results, Math.round(t.revenue * 100) / 100]);
  // Série diária por cliente (60 dias: janela atual e a anterior) para o gráfico da página do cliente.
  const cdaily: Record<string, { day: string; spend: number; conv: number; rev: number }[]> = {};
  for (const r of clientDailyRows) (cdaily[r.client_id] ??= []).push({ day: r.day, spend: num(r.spend), conv: num(r.results), rev: num(r.revenue) });
  const daily = [...dailyMap.entries()].map(([d, t]) => ({ day: d, spend: Math.round(t.spend * 100) / 100, conv: t.results, rev: Math.round(t.revenue * 100) / 100 }));

  const reports = reportRows.map((r) => ({
    id: r.id,
    client: r.client_id,
    title: r.title,
    freq: "Mensal",
    next: "—",
    status: r.status === "published" ? "Enviado" : "Rascunho",
    last: r.status === "published" ? `Publicado ${relative(r.published_at, now)}` : `Rascunho de ${relative(r.created_at, now)}${r.by_xodo ? ` · ${r.by_xodo}` : ""}`,
    period: `${r.period_start} a ${r.period_end}`,
  }));

  const team = memberRows.map((m) => {
    const name = m.full_name || m.email || "Sem nome";
    return { user_id: m.user_id, name, ini: initials(name), role: m.title || ROLE_LABEL[m.role] || m.role, perm: ROLE_LABEL[m.role] || m.role, roleKey: m.role, email: m.email, clients: m.clients, projects: 0, tasks: 0, cap: 0 };
  });

  const attention: Record<string, unknown>[] = [];
  for (const c of clients) {
    const gap = goalGap(c.cur === null ? null : c.gt, c.goal, c.cur);
    if (gap !== null && gap > 10) {
      attention.push({ tone: gap > 25 ? "red" : "amber", kind: "Campanha", icon: "trending_up", client: c.name, title: `${c.gt} ${Math.round(gap)}% ${c.gt === "ROAS" ? "abaixo" : "acima"} da meta`,
        ev: `Últimos 30 dias · meta ${c.gt === "ROAS" ? `${c.goal}x` : `R$ ${c.goal}`}`, action: "Ver campanhas", go: "campaigns", extra: { campView: "Com problema" } });
    }
  }
  for (const a of accounts.filter((x) => x.last_sync_error).slice(0, 5)) {
    attention.push({ tone: "red", kind: "Integração", icon: "sync_problem", client: clients.find((c) => c.id === a.client_id)?.name ?? "", title: `Erro ao sincronizar ${PLATFORM_LABEL[a.platform] ?? a.platform}`,
      ev: (a.last_sync_error ?? "").slice(0, 140), action: "Ver integrações", go: "integrations", extra: {} });
  }
  for (const conn of connections.filter((c) => c.status === "error" || c.status === "expired").slice(0, 5)) {
    attention.push({ tone: "amber", kind: "Integração", icon: "link_off", client: conn.label, title: "Conexão precisa ser refeita", ev: conn.last_error ?? "O login venceu.", action: "Reconectar", go: "integrations", extra: {} });
  }
  if ((pending?.n ?? 0) > 0) {
    attention.push({ tone: "blue", kind: "Xodó", icon: "smart_toy", client: "Xodós", title: `${pending!.n} pedido(s) esperando aprovação`, ev: "Os xodós continuam depois da sua resposta", action: "Ver pedidos", go: "xodo", extra: {} });
  }

  const sum = (key: "cur" | "prev", field: keyof Totals) => [...totals.values()].reduce((t, v) => t + v[key][field], 0);
  const kpis = {
    mrr: clients.filter((c) => c.status !== "encerrado").reduce((t, c) => t + c.mrr, 0),
    activeClients: clients.filter((c) => c.status === "ativo" || c.status === "onboarding").length,
    spend: { cur: sum("cur", "spend"), prev: sum("prev", "spend") },
    results: { cur: sum("cur", "results"), prev: sum("prev", "results") },
    revenue: { cur: sum("cur", "revenue"), prev: sum("prev", "revenue") },
  };

  return {
    agency: { id: agencyId, ...agency },
    me: { user_id: userId, name: me?.full_name || me?.email || "", role: me?.role ?? null, email: me?.email ?? null },
    period: cur,
    clients,
    camps,
    plat,
    daily,
    cdaily,
    reports,
    team,
    invites: inviteRows,
    attention,
    kpis,
    connections,
    accounts,
    pendingApprovals: pending?.n ?? 0,
    documents,
  };
}
