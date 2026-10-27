import { z } from "zod";
import { dayIn } from "../xodos/budget";
import { json, num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import type { Mailer } from "./email";
import { PLAN_IDS, planPrices, platformFlags, type Prices } from "./platform";

/**
 * Admin do Spherum: a equipe vê todas as agências, leads do site, cupons, comunicados, status da
 * plataforma, suporte, auditoria e a própria equipe. Cada ação confere o papel de quem pede e fica
 * na auditoria. A cobrança do Spherum ainda não existe: a receita é estimada pelos preços de tabela.
 */

export const STAFF_ROLES = ["dono", "operacao", "suporte", "financeiro", "leitura"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

const CAN = {
  plan: ["dono", "operacao", "financeiro"],
  suspend: ["dono", "operacao"],
  message: ["dono", "operacao", "suporte"],
  staff: ["dono"],
  settings: ["dono"],
  coupons: ["dono", "operacao", "financeiro"],
  comms: ["dono", "operacao"],
  status: ["dono", "operacao"],
  support: ["dono", "operacao", "suporte"],
  leads: ["dono", "operacao", "suporte"],
} satisfies Record<string, StaffRole[]>;
export type StaffAction = keyof typeof CAN;

export function staffCan(role: string, what: StaffAction) {
  if (!(CAN[what] as readonly string[]).includes(role)) throw new XodoError("Seu papel na equipe do Spherum não permite esta ação.", 403);
}

export type AdminDeps = { sql: Sql; mail: Mailer; appUrl: string };

const TZ = "America/Sao_Paulo";
const daysAgo = (now: Date, n: number) => dayIn(TZ, new Date(now.getTime() - n * 864e5));

/** Saúde 0 a 100: acesso recente, clientes, integrações e xodós (regras simples, explicáveis). */
export function agencyHealth(a: { last_seen: string | null; clients: number; connections: number; xodos: number }, now: Date) {
  let h = 100;
  const seen = a.last_seen ? (now.getTime() - Date.parse(a.last_seen)) / 864e5 : Infinity;
  if (seen > 21) h -= 40; else if (seen > 7) h -= 20; else if (seen > 3) h -= 8;
  if (!a.clients) h -= 20;
  if (!a.connections) h -= 15;
  if (!a.xodos) h -= 5;
  return Math.max(0, Math.min(100, h));
}

/** Tudo o que as telas do admin mostram, numa leitura. */
export async function adminBoard(sql: Sql, userId: string, role: string, now = new Date()) {
  const since30 = daysAgo(now, 29);
  const [me, agencies, leads, coupons, comms, incidents, updates, cron, staff, auditRows, tickets, tmsgs, aiProv, aiTop, signups, leadKinds, flags, prices] = await Promise.all([
    one<{ name: string | null; email: string | null }>(sql, `select p.full_name as name, u.email from auth.users u left join profiles p on p.id = u.id where u.id = $1`, [userId]),
    sql.query<{ id: string; name: string; plan: string; plan_status: string; trial_ends_at: string | null; created_at: string; suspended_at: string | null; suspended_reason: string | null;
      city: string | null; state: string | null; coupon: string | null; owner_name: string | null; owner_email: string | null; members: number; clients: number; xodos: number;
      last_seen: string | null; ai_brl: number; connections: number }>(
      `select a.id, a.name, a.plan, a.plan_status, a.trial_ends_at::text, a.created_at::text, a.suspended_at::text, a.suspended_reason, a.city, a.state,
              a.onboarding->>'coupon' as coupon, o.full_name as owner_name, ou.email as owner_email,
              (select count(*)::int from agency_members m where m.agency_id = a.id) as members,
              (select count(*)::int from clients c where c.agency_id = a.id and c.archived_at is null) as clients,
              (select count(*)::int from xodos x where x.agency_id = a.id) as xodos,
              (select max(u.last_sign_in_at)::text from agency_members m join auth.users u on u.id = m.user_id where m.agency_id = a.id) as last_seen,
              (select coalesce(sum(g.cost_brl), 0)::float8 from ai_usage g where g.agency_id = a.id and g.day >= $1::date) as ai_brl,
              (select count(*)::int from integration_connections ic where ic.agency_id = a.id and ic.status = 'active') as connections
         from agencies a
         left join lateral (select user_id from agency_members m where m.agency_id = a.id and m.role = 'owner' order by m.created_at limit 1) ow on true
         left join profiles o on o.id = ow.user_id left join auth.users ou on ou.id = ow.user_id
        order by a.created_at desc limit 2000`,
      [since30],
    ),
    sql.query<{ id: string; kind: string; name: string | null; email: string | null; phone: string | null; company: string | null; message: string | null; payload: Record<string, unknown>;
      stage: string; owner_user: string | null; owner_name: string | null; note: string | null; scheduled_for: string | null; created_at: string }>(
      `select l.id, l.kind, l.name, l.email, l.phone, l.company, l.message, l.payload, l.stage, l.owner_user, coalesce(p.full_name, u.email) as owner_name, l.note,
              l.scheduled_for::text, l.created_at::text
         from site_leads l left join profiles p on p.id = l.owner_user left join auth.users u on u.id = l.owner_user
        order by l.created_at desc limit 500`,
    ),
    sql.query(`select code, description, kind, value::float8 as value, months, plans, max_uses, uses, valid_until::text, status, note, created_at::text from coupons order by created_at desc`),
    sql.query(`select id, title, body, channel, segment, cta_label, cta_url, status, send_at::text, sent_at::text, reach, created_at::text from announcements order by created_at desc limit 100`),
    sql.query<{ id: string; service: string; title: string; severity: string; status: string; started_at: string; resolved_at: string | null }>(
      `select id, service, title, severity, status, started_at::text, resolved_at::text from status_incidents order by started_at desc limit 50`),
    sql.query<{ incident_id: string; status: string; text: string; created_at: string }>(
      `select incident_id, status, text, created_at::text from status_updates where incident_id in (select id from status_incidents order by started_at desc limit 50) order by created_at desc`),
    sql.query<{ started_at: string; finished_at: string | null; failed: string[] }>(`select started_at::text, finished_at::text, failed from cron_runs order by started_at desc limit 96`),
    sql.query<{ user_id: string; role: string; name: string | null; email: string | null; last_seen: string | null; created_at: string }>(
      `select s.user_id, s.role, p.full_name as name, u.email, u.last_sign_in_at::text as last_seen, s.created_at::text
         from spherum_staff s join auth.users u on u.id = s.user_id left join profiles p on p.id = s.user_id order by s.created_at`),
    sql.query<{ id: number; agency_id: string | null; agency_name: string | null; action: string; summary: string | null; actor: string | null; staff: boolean; created_at: string }>(
      `select e.id, e.agency_id, a.name as agency_name, e.action, e.summary, coalesce(p.full_name, u.email) as actor,
              exists (select 1 from spherum_staff s where s.user_id = e.actor_user_id) as staff, e.created_at::text
         from audit_events e left join agencies a on a.id = e.agency_id left join profiles p on p.id = e.actor_user_id left join auth.users u on u.id = e.actor_user_id
        order by e.id desc limit 300`),
    sql.query<{ id: string; agency_id: string; agency_name: string; subject: string; priority: string; status: string; opener: string | null; created_at: string; updated_at: string }>(
      `select t.id, t.agency_id, a.name as agency_name, t.subject, t.priority, t.status, coalesce(p.full_name, u.email) as opener, t.created_at::text, t.updated_at::text
         from support_tickets t join agencies a on a.id = t.agency_id left join profiles p on p.id = t.opened_by left join auth.users u on u.id = t.opened_by
        order by (t.status = 'open') desc, t.updated_at desc limit 300`),
    sql.query<{ ticket_id: string; side: string; text: string; author: string | null; created_at: string }>(
      `select m.ticket_id, m.side, m.text, coalesce(p.full_name, u.email) as author, m.created_at::text
         from support_messages m left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
        where m.ticket_id in (select id from support_tickets order by updated_at desc limit 300) order by m.id`),
    sql.query<{ provider: string; calls: number; brl: number; errors: number; tokens: number }>(
      `select provider, count(*)::int as calls, coalesce(sum(cost_brl), 0)::float8 as brl, count(*) filter (where error is not null)::int as errors,
              coalesce(sum(input_tokens + output_tokens), 0)::float8 as tokens
         from ai_usage where day >= $1::date group by provider order by calls desc`, [since30]),
    sql.query<{ agency_id: string; name: string; brl: number; calls: number }>(
      `select g.agency_id, a.name, coalesce(sum(g.cost_brl), 0)::float8 as brl, count(*)::int as calls
         from ai_usage g join agencies a on a.id = g.agency_id where g.day >= $1::date group by g.agency_id, a.name order by brl desc limit 10`, [since30]),
    sql.query<{ m: string; n: number }>(
      `select to_char(created_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as m, count(*)::int as n from agencies
        where created_at >= ($1::date - interval '12 months') group by 1 order by 1`, [dayIn(TZ, now)]),
    sql.query<{ kind: string; n: number }>(`select kind, count(*)::int as n from site_leads where created_at >= $1::date group by kind`, [since30]),
    platformFlags(sql),
    planPrices(sql),
  ]);

  const priceOf = (plan: string) => (prices as Prices)[plan as keyof Prices] ?? 0;
  const ag = agencies.map((a) => ({ ...a, ai_brl: num(a.ai_brl), health: agencyHealth(a, now), mrr: a.plan_status === "active" && !a.suspended_at ? priceOf(a.plan) : 0 }));
  // Receita estimada: agências pagantes (marcadas como "active") pelo preço de tabela do plano.
  const months: string[] = [];
  for (let k = 11; k >= 0; k--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 15)); months.push(d.toISOString().slice(0, 7)); }
  const series = months.map((m) => ({ m, v: ag.filter((a) => a.mrr && a.created_at.slice(0, 7) <= m).reduce((t, a) => t + a.mrr, 0) }));
  const byTicket = new Map<string, typeof tmsgs>();
  for (const m of tmsgs) byTicket.set(m.ticket_id, [...(byTicket.get(m.ticket_id) ?? []), m]);
  const byIncident = new Map<string, typeof updates>();
  for (const u of updates) byIncident.set(u.incident_id, [...(byIncident.get(u.incident_id) ?? []), u]);
  // Saúde por serviço pelas etapas do cron nas últimas 24 h.
  const STEPS: Record<string, string[]> = { app: ["canais", "fila", "uploads"], meta: ["anuncios", "logins", "posts"], google: ["anuncios"], wa: ["prospeccao", "canais"], xodo: ["execucoes", "rotinas", "computador", "email"], pay: ["cobranca", "fiscal"] };
  const day = cron.filter((r) => now.getTime() - Date.parse(r.started_at) < 864e5);
  const services = Object.entries(STEPS).map(([id, steps]) => {
    const bad = day.filter((r) => r.failed.some((f) => steps.includes(f))).length;
    return { id, runs: day.length, failed: bad, uptime: day.length ? Math.round(((day.length - bad) / day.length) * 10000) / 100 : null };
  });

  return {
    me: { user_id: userId, role, name: me?.name || me?.email || "", email: me?.email ?? null },
    flags, prices,
    agencies: ag,
    mrr: { now: series[series.length - 1].v, series, paying: ag.filter((a) => a.mrr).length },
    metrics: {
      signups: months.map((m) => ({ m, n: signups.find((s) => s.m === m)?.n ?? 0 })),
      leads30: Object.fromEntries(leadKinds.map((k) => [k.kind, k.n])),
      created30: ag.filter((a) => a.created_at >= since30).length,
      trial: ag.filter((a) => a.plan_status === "trial" && !a.suspended_at).length,
      paying: ag.filter((a) => a.plan_status === "active" && !a.suspended_at).length,
      canceled: ag.filter((a) => a.plan_status === "canceled").length,
      suspended: ag.filter((a) => a.suspended_at).length,
      plans: Object.fromEntries(PLAN_IDS.map((p) => [p, ag.filter((a) => a.plan === p && !a.suspended_at && a.plan_status !== "canceled").length])),
    },
    leads,
    coupons,
    comms,
    incidents: incidents.map((i) => ({ ...i, updates: byIncident.get(i.id) ?? [] })),
    cron: { last: cron[0] ?? null, services },
    staff,
    audit: auditRows,
    tickets: tickets.map((t) => ({ ...t, messages: byTicket.get(t.id) ?? [] })),
    ai: { providers: aiProv.map((p) => ({ ...p, brl: num(p.brl), tokens: num(p.tokens) })), top: aiTop.map((t) => ({ ...t, brl: num(t.brl) })) },
  };
}

// ---------------------------------------------------------------------------
// Agências
// ---------------------------------------------------------------------------

export const agencyAdminInput = z.object({
  plan: z.enum(PLAN_IDS).optional(),
  plan_status: z.enum(["trial", "active", "past_due", "canceled"]).optional(),
  /** Estende o teste grátis em N dias a partir de hoje (ou do fim atual, se ainda não venceu). */
  trial_days: z.number().int().min(1).max(90).optional(),
  suspend: z.object({ reason: z.string().trim().min(5).max(500) }).optional(),
  reactivate: z.literal(true).optional(),
});

export async function updateAgencyAdmin(sql: Sql, actor: { id: string; role: string }, agencyId: string, raw: unknown, now = new Date()) {
  const i = agencyAdminInput.parse(raw);
  const a = await one<{ name: string; plan: string; plan_status: string; trial_ends_at: string | null; suspended_at: string | null }>(
    sql, `select name, plan, plan_status, trial_ends_at::text, suspended_at::text from agencies where id = $1`, [agencyId]);
  if (!a) throw new XodoError("Agência não encontrada.", 404);
  const log = (action: string, summary: string) => audit(sql, { agencyId, actor: actor.id, action, targetType: "agency", targetId: agencyId, summary });
  if (i.plan && i.plan !== a.plan) {
    staffCan(actor.role, "plan");
    await sql.query(`update agencies set plan = $2 where id = $1`, [agencyId, i.plan]);
    await log("admin_plano", `Plano de ${a.name}: ${a.plan} → ${i.plan}`);
  }
  if (i.plan_status && i.plan_status !== a.plan_status) {
    staffCan(actor.role, "plan");
    await sql.query(`update agencies set plan_status = $2 where id = $1`, [agencyId, i.plan_status]);
    await log("admin_situacao", `Situação de ${a.name}: ${a.plan_status} → ${i.plan_status}`);
  }
  if (i.trial_days) {
    staffCan(actor.role, "plan");
    const from = a.trial_ends_at && Date.parse(a.trial_ends_at) > now.getTime() ? new Date(a.trial_ends_at) : now;
    const until = new Date(from.getTime() + i.trial_days * 864e5).toISOString();
    await sql.query(`update agencies set trial_ends_at = $2::timestamptz, plan_status = case when plan_status = 'canceled' then plan_status else 'trial' end where id = $1`, [agencyId, until]);
    await log("admin_teste", `Teste de ${a.name} estendido em ${i.trial_days} dias`);
  }
  if (i.suspend) {
    staffCan(actor.role, "suspend");
    if (a.suspended_at) throw new XodoError("Essa agência já está suspensa.", 409);
    await sql.query(`update agencies set suspended_at = $2, suspended_reason = $3 where id = $1`, [agencyId, now.toISOString(), i.suspend.reason]);
    await log("admin_suspensao", `${a.name} suspensa: ${i.suspend.reason}`);
  }
  if (i.reactivate) {
    staffCan(actor.role, "suspend");
    if (!a.suspended_at) throw new XodoError("Essa agência não está suspensa.", 409);
    await sql.query(`update agencies set suspended_at = null, suspended_reason = null where id = $1`, [agencyId]);
    await log("admin_reativacao", `${a.name} reativada`);
  }
}

export const messageInput = z.object({ subject: z.string().trim().min(3).max(160), body: z.string().trim().min(3).max(4000) });

/** Mensagem da equipe do Spherum: aviso no app da agência e e-mail para donos e admins. */
export async function messageAgency(deps: AdminDeps, actor: { id: string; role: string }, agencyId: string, raw: unknown) {
  staffCan(actor.role, "message");
  const i = messageInput.parse(raw);
  const a = await one<{ name: string }>(deps.sql, `select name from agencies where id = $1`, [agencyId]);
  if (!a) throw new XodoError("Agência não encontrada.", 404);
  await deps.sql.query(`insert into notifications (agency_id, kind, title, body, data) values ($1, 'spherum_mensagem', $2, $3, '{}'::jsonb)`, [agencyId, i.subject, i.body.slice(0, 2000)]);
  const to = await leaders(deps.sql, agencyId);
  const sent = to.length ? await deps.mail({ to, subject: `${i.subject} · Spherum`, text: `${i.body}\n\nEquipe Spherum`, replyTo: "suporte@spherum.com.br" }).catch(() => false) : false;
  await audit(deps.sql, { agencyId, actor: actor.id, action: "admin_mensagem", targetType: "agency", targetId: agencyId, summary: `Mensagem para ${a.name}: ${i.subject}` });
  return { emailed: sent };
}

async function leaders(sql: Sql, agencyId: string) {
  const rows = await sql.query<{ email: string | null }>(
    `select u.email from agency_members m join auth.users u on u.id = m.user_id where m.agency_id = $1 and m.role in ('owner', 'admin') and u.email is not null`, [agencyId]);
  return rows.map((r) => r.email!).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Equipe do Spherum
// ---------------------------------------------------------------------------

export const staffInput = z.object({ email: z.email().trim().toLowerCase().max(254), role: z.enum(STAFF_ROLES) });

export async function addStaff(sql: Sql, actor: { id: string; role: string }, raw: unknown) {
  staffCan(actor.role, "staff");
  const i = staffInput.parse(raw);
  const u = await one<{ id: string }>(sql, `select id from auth.users where lower(email) = $1`, [i.email]);
  if (!u) throw new XodoError("Essa pessoa ainda não tem conta. Peça para ela se cadastrar em spherum.com.br e convide de novo.", 404);
  const r = await one(sql, `insert into spherum_staff (user_id, role, invited_by) values ($1, $2, $3) on conflict (user_id) do nothing returning user_id`, [u.id, i.role, actor.id]);
  if (!r) throw new XodoError("Essa pessoa já é da equipe.", 409);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_equipe", targetType: "staff", targetId: u.id, summary: `${i.email} entrou na equipe como ${i.role}` });
  return { user_id: u.id };
}

async function donos(sql: Sql) {
  return (await one<{ n: number }>(sql, `select count(*)::int as n from spherum_staff where role = 'dono'`))!.n;
}

export async function updateStaff(sql: Sql, actor: { id: string; role: string }, userId: string, raw: unknown) {
  staffCan(actor.role, "staff");
  const role = z.object({ role: z.enum(STAFF_ROLES) }).parse(raw).role;
  const cur = await one<{ role: string }>(sql, `select role from spherum_staff where user_id = $1`, [userId]);
  if (!cur) throw new XodoError("Pessoa não encontrada na equipe.", 404);
  if (cur.role === "dono" && role !== "dono" && (await donos(sql)) <= 1) throw new XodoError("A equipe precisa de pelo menos um dono.", 409);
  await sql.query(`update spherum_staff set role = $2 where user_id = $1`, [userId, role]);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_equipe", targetType: "staff", targetId: userId, summary: `Papel na equipe: ${cur.role} → ${role}` });
}

export async function removeStaff(sql: Sql, actor: { id: string; role: string }, userId: string) {
  staffCan(actor.role, "staff");
  const cur = await one<{ role: string }>(sql, `select role from spherum_staff where user_id = $1`, [userId]);
  if (!cur) throw new XodoError("Pessoa não encontrada na equipe.", 404);
  if (cur.role === "dono" && (await donos(sql)) <= 1) throw new XodoError("A equipe precisa de pelo menos um dono.", 409);
  await sql.query(`delete from spherum_staff where user_id = $1`, [userId]);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_equipe", targetType: "staff", targetId: userId, summary: "Saiu da equipe do Spherum" });
}

// ---------------------------------------------------------------------------
// Cupons
// ---------------------------------------------------------------------------

export const couponInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,24}$/, "Use de 3 a 24 letras e números, sem espaço."),
  description: z.string().trim().min(3).max(200),
  kind: z.enum(["pct", "brl"]),
  value: z.number().positive().max(100_000),
  months: z.number().int().min(1).max(36).default(1),
  plans: z.array(z.enum(PLAN_IDS)).max(5).default([]),
  max_uses: z.number().int().positive().nullable().optional(),
  valid_until: z.iso.date().nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
}).refine((c) => c.kind !== "pct" || c.value <= 100, { message: "Desconto em porcentagem vai até 100%.", path: ["value"] });

export async function createCoupon(sql: Sql, actor: { id: string; role: string }, raw: unknown) {
  staffCan(actor.role, "coupons");
  const c = couponInput.parse(raw);
  const r = await one(sql,
    `insert into coupons (code, description, kind, value, months, plans, max_uses, valid_until, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (code) do nothing returning code`,
    [c.code, c.description, c.kind, c.value, c.months, c.plans, c.max_uses ?? null, c.valid_until ?? null, c.note ?? null, actor.id]);
  if (!r) throw new XodoError("Já existe um cupom com esse código.", 409);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_cupom", targetType: "coupon", targetId: c.code, summary: `Cupom ${c.code} criado` });
  return { code: c.code };
}

export async function updateCoupon(sql: Sql, actor: { id: string; role: string }, code: string, raw: unknown) {
  staffCan(actor.role, "coupons");
  const i = z.object({ status: z.enum(["active", "paused"]).optional(), max_uses: z.number().int().positive().nullable().optional(), valid_until: z.iso.date().nullable().optional(), description: z.string().trim().min(3).max(200).optional() }).parse(raw);
  const r = await one(sql,
    `update coupons set status = coalesce($2, status), description = coalesce($3, description),
            max_uses = case when $4 then $5 else max_uses end, valid_until = case when $6 then $7::date else valid_until end
      where code = $1 returning code`,
    [code, i.status ?? null, i.description ?? null, i.max_uses !== undefined, i.max_uses ?? null, i.valid_until !== undefined, i.valid_until ?? null]);
  if (!r) throw new XodoError("Cupom não encontrado.", 404);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_cupom", targetType: "coupon", targetId: code, summary: `Cupom ${code} alterado${i.status ? ` (${i.status === "paused" ? "pausado" : "ativo"})` : ""}` });
}

export async function deleteCoupon(sql: Sql, actor: { id: string; role: string }, code: string) {
  staffCan(actor.role, "coupons");
  const c = await one<{ uses: number }>(sql, `select uses from coupons where code = $1`, [code]);
  if (!c) throw new XodoError("Cupom não encontrado.", 404);
  if (c.uses > 0) throw new XodoError("Cupom já usado não pode ser apagado; pause em vez disso.", 409);
  await sql.query(`delete from coupons where code = $1`, [code]);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_cupom", targetType: "coupon", targetId: code, summary: `Cupom ${code} apagado` });
}

// ---------------------------------------------------------------------------
// Comunicados
// ---------------------------------------------------------------------------

export const announcementInput = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(3).max(4000),
  channel: z.enum(["banner", "email", "both"]).default("banner"),
  segment: z.string().regex(/^(all|paid|trial|xodo|plan:(solo|agencia|escala|rede|empresarial))$/).default("all"),
  cta_label: z.string().trim().max(40).nullable().optional(),
  cta_url: z.url({ protocol: /^https$/ }).max(500).nullable().optional(),
  send: z.enum(["now", "schedule", "draft"]).default("draft"),
  send_at: z.iso.datetime({ offset: true }).optional(),
});

function segmentWhere(segment: string): [string, unknown[]] {
  if (segment === "paid") return [`a.plan_status = 'active'`, []];
  if (segment === "trial") return [`a.plan_status = 'trial'`, []];
  if (segment === "xodo") return [`exists (select 1 from xodos x where x.agency_id = a.id)`, []];
  if (segment.startsWith("plan:")) return [`a.plan = $1`, [segment.slice(5)]];
  return ["true", []];
}

export async function createAnnouncement(deps: AdminDeps, actor: { id: string; role: string }, raw: unknown, now = new Date()) {
  staffCan(actor.role, "comms");
  const i = announcementInput.parse(raw);
  if (i.send === "schedule" && (!i.send_at || Date.parse(i.send_at) <= now.getTime())) throw new XodoError("Escolha uma data no futuro para o envio.", 400);
  const row = (await one<{ id: string }>(deps.sql,
    `insert into announcements (title, body, channel, segment, cta_label, cta_url, status, send_at, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [i.title, i.body, i.channel, i.segment, i.cta_label ?? null, i.cta_url ?? null, i.send === "schedule" ? "scheduled" : "draft", i.send === "schedule" ? i.send_at : null, actor.id]))!;
  await audit(deps.sql, { agencyId: null, actor: actor.id, action: "admin_comunicado", targetType: "announcement", targetId: row.id, summary: `Comunicado "${i.title}" ${i.send === "now" ? "enviado" : i.send === "schedule" ? "agendado" : "salvo como rascunho"}` });
  if (i.send === "now") return { id: row.id, ...(await sendAnnouncement(deps, row.id, now)) };
  return { id: row.id, reach: 0 };
}

/** Entrega: um aviso no app de cada agência do segmento e, se pedido, e-mail aos donos e admins. Só uma vez. */
export async function sendAnnouncement(deps: AdminDeps, id: string, now = new Date()) {
  const claimed = await one<{ title: string; body: string; channel: string; segment: string; cta_label: string | null; cta_url: string | null }>(deps.sql,
    `update announcements set status = 'sent', sent_at = $2 where id = $1 and status in ('draft', 'scheduled') returning title, body, channel, segment, cta_label, cta_url`, [id, now.toISOString()]);
  if (!claimed) throw new XodoError("Esse comunicado já foi enviado.", 409);
  const [where, params] = segmentWhere(claimed.segment);
  const targets = await deps.sql.query<{ id: string }>(`select a.id from agencies a where a.suspended_at is null and ${where}`, params);
  const data = JSON.stringify({ announcement_id: id, cta_label: claimed.cta_label, cta_url: claimed.cta_url });
  let emailed = 0;
  for (const t of targets) {
    if (claimed.channel !== "email") await deps.sql.query(`insert into notifications (agency_id, kind, title, body, data) values ($1, 'comunicado', $2, $3, $4::jsonb)`, [t.id, claimed.title, claimed.body.slice(0, 2000), data]);
    if (claimed.channel !== "banner") {
      const to = await leaders(deps.sql, t.id);
      if (to.length && (await deps.mail({ to, subject: claimed.title, text: `${claimed.body}${claimed.cta_url ? `\n\n${claimed.cta_label || "Saiba mais"}: ${claimed.cta_url}` : ""}\n\nEquipe Spherum` }).catch(() => false))) emailed++;
    }
  }
  await deps.sql.query(`update announcements set reach = $2 where id = $1`, [id, targets.length]);
  return { reach: targets.length, emailed };
}

/** Cron: comunicados agendados que chegaram na hora. */
export async function announcementSweep(deps: AdminDeps, now = new Date()) {
  const due = await deps.sql.query<{ id: string }>(`select id from announcements where status = 'scheduled' and send_at <= $1 order by send_at limit 10`, [now.toISOString()]);
  let sent = 0;
  for (const d of due) { try { await sendAnnouncement(deps, d.id, now); sent++; } catch { /* outra varredura já enviou */ } }
  return sent;
}

export async function deleteAnnouncement(sql: Sql, actor: { id: string; role: string }, id: string) {
  staffCan(actor.role, "comms");
  const r = await one(sql, `delete from announcements where id = $1 and status <> 'sent' returning id`, [id]);
  if (!r) throw new XodoError("Comunicado enviado não pode ser apagado.", 409);
}

// ---------------------------------------------------------------------------
// Status da plataforma
// ---------------------------------------------------------------------------

const SERVICES = ["app", "meta", "google", "wa", "xodo", "pay"] as const;
const INC_STATUS = ["investigating", "identified", "monitoring", "resolved"] as const;

export async function createIncident(sql: Sql, actor: { id: string; role: string }, raw: unknown, now = new Date()) {
  staffCan(actor.role, "status");
  const i = z.object({ service: z.enum(SERVICES), title: z.string().trim().min(3).max(160), severity: z.enum(["minor", "major", "critical"]).default("minor"), text: z.string().trim().min(3).max(2000) }).parse(raw);
  const row = (await one<{ id: string }>(sql, `insert into status_incidents (service, title, severity, started_at, created_by) values ($1, $2, $3, $4, $5) returning id`, [i.service, i.title, i.severity, now.toISOString(), actor.id]))!;
  await sql.query(`insert into status_updates (incident_id, status, text, author_user, created_at) values ($1, 'investigating', $2, $3, $4)`, [row.id, i.text, actor.id, now.toISOString()]);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_status", targetType: "incident", targetId: row.id, summary: `Incidente aberto: ${i.title}` });
  return row;
}

export async function updateIncident(sql: Sql, actor: { id: string; role: string }, id: string, raw: unknown, now = new Date()) {
  staffCan(actor.role, "status");
  const i = z.object({ status: z.enum(INC_STATUS), text: z.string().trim().min(3).max(2000) }).parse(raw);
  const r = await one<{ title: string }>(sql,
    `update status_incidents set status = $2, resolved_at = case when $2 = 'resolved' then $3::timestamptz else null end where id = $1 and status <> 'resolved' returning title`,
    [id, i.status, now.toISOString()]);
  if (!r) throw new XodoError("Incidente não encontrado ou já resolvido.", 404);
  await sql.query(`insert into status_updates (incident_id, status, text, author_user, created_at) values ($1, $2, $3, $4, $5)`, [id, i.status, i.text, actor.id, now.toISOString()]);
  await audit(sql, { agencyId: null, actor: actor.id, action: "admin_status", targetType: "incident", targetId: id, summary: `Incidente "${r.title}": ${i.status}` });
}

/** Agendador: cada execução registra o que falhou (o admin mostra a saúde por serviço). */
export async function recordCronRun(sql: Sql, startedAt: Date, result: Record<string, unknown>) {
  const failed = Object.entries(result).filter(([, v]) => typeof v === "string" && v.startsWith("falhou")).map(([k]) => k);
  await sql.query(`insert into cron_runs (started_at, finished_at, failed, result) values ($1, now(), $2, $3::jsonb)`, [startedAt.toISOString(), failed, json(result)]);
  await sql.query(`delete from cron_runs where started_at < now() - interval '14 days'`);
}

// ---------------------------------------------------------------------------
// Suporte (lado do Spherum)
// ---------------------------------------------------------------------------

export async function replySupport(deps: AdminDeps, actor: { id: string; role: string }, ticketId: string, raw: unknown) {
  staffCan(actor.role, "support");
  const text = z.object({ text: z.string().trim().min(2).max(4000) }).parse(raw).text;
  const t = await one<{ agency_id: string; subject: string; opened_by: string | null }>(deps.sql, `select agency_id, subject, opened_by from support_tickets where id = $1`, [ticketId]);
  if (!t) throw new XodoError("Chamado não encontrado.", 404);
  await deps.sql.query(`insert into support_messages (ticket_id, side, author_user, text) values ($1, 'sp', $2, $3)`, [ticketId, actor.id, text]);
  await deps.sql.query(`update support_tickets set updated_at = now() where id = $1`, [ticketId]);
  await deps.sql.query(`insert into notifications (agency_id, user_id, kind, title, body, data) values ($1, $2, 'suporte_resposta', $3, $4, $5::jsonb)`,
    [t.agency_id, t.opened_by, `Resposta do suporte: ${t.subject}`.slice(0, 200), text.slice(0, 500), JSON.stringify({ ticket_id: ticketId })]);
  const opener = t.opened_by ? await one<{ email: string | null }>(deps.sql, `select email from auth.users where id = $1`, [t.opened_by]) : null;
  if (opener?.email) await deps.mail({ to: opener.email, subject: `Re: ${t.subject} · Suporte Spherum`, text: `${text}\n\nResponda pelo app em Ajuda e suporte.\n\nEquipe Spherum` }).catch(() => false);
  await audit(deps.sql, { agencyId: t.agency_id, actor: actor.id, action: "admin_suporte", targetType: "support_ticket", targetId: ticketId, summary: `Resposta no chamado "${t.subject}"` });
}

export async function setSupportStatus(sql: Sql, actor: { id: string; role: string }, ticketId: string, raw: unknown) {
  staffCan(actor.role, "support");
  const status = z.object({ status: z.enum(["open", "done"]) }).parse(raw).status;
  const t = await one<{ agency_id: string; subject: string }>(sql, `update support_tickets set status = $2 where id = $1 returning agency_id, subject`, [ticketId, status]);
  if (!t) throw new XodoError("Chamado não encontrado.", 404);
  await audit(sql, { agencyId: t.agency_id, actor: actor.id, action: "admin_suporte", targetType: "support_ticket", targetId: ticketId, summary: `Chamado "${t.subject}" ${status === "done" ? "resolvido" : "reaberto"}` });
}

// ---------------------------------------------------------------------------
// Leads do site
// ---------------------------------------------------------------------------

export const leadPatch = z.object({
  stage: z.enum(["new", "contacted", "demo", "trial", "won", "lost"]).optional(),
  owner_user: z.uuid().nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

export async function updateSiteLead(sql: Sql, actor: { id: string; role: string }, id: string, raw: unknown) {
  staffCan(actor.role, "leads");
  const i = leadPatch.parse(raw);
  if (i.owner_user && !(await one(sql, `select 1 from spherum_staff where user_id = $1`, [i.owner_user]))) throw new XodoError("Essa pessoa não é da equipe do Spherum.", 400);
  const r = await one(sql,
    `update site_leads set stage = coalesce($2, stage), owner_user = case when $3 then $4 else owner_user end, note = case when $5 then $6 else note end,
            handled_at = case when coalesce($2, stage) <> 'new' then coalesce(handled_at, now()) else handled_at end
      where id = $1 returning id`,
    [id, i.stage ?? null, i.owner_user !== undefined, i.owner_user ?? null, i.note !== undefined, i.note ?? null]);
  if (!r) throw new XodoError("Lead não encontrado.", 404);
}

export const manualLeadInput = z.object({
  company: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase().max(254),
  phone: z.string().trim().max(40).optional(),
  clients: z.number().int().min(0).max(100_000).optional(),
  plan: z.enum(PLAN_IDS).optional(),
  note: z.string().trim().max(2000).optional(),
});

export async function createManualLead(sql: Sql, actor: { id: string; role: string }, raw: unknown) {
  staffCan(actor.role, "leads");
  const i = manualLeadInput.parse(raw);
  if (await one(sql, `select 1 from site_leads where lower(email) = $1 and stage not in ('won', 'lost')`, [i.email])) throw new XodoError("Esse lead já está no funil.", 409);
  return (await one<{ id: string }>(sql,
    `insert into site_leads (kind, name, email, phone, company, payload, stage, owner_user, note) values ('contato', $1, $2, $3, $4, $5::jsonb, 'new', $6, $7) returning id`,
    [i.name, i.email, i.phone ?? null, i.company, JSON.stringify({ source: "manual", clients: i.clients ?? null, plan: i.plan ?? null }), actor.id, i.note ?? null]))!;
}
