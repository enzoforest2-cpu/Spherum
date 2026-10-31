import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { asaas } from "../billing/providers/asaas";
import type { ChargeState, PaymentProvider, ProviderCtx } from "../billing/types";
import { IntegrationError, requestJson } from "../integrations/http";
import { dayIn } from "../xodos/budget";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { staffAlert } from "./alerts";
import { audit } from "./audit";
import type { Mailer } from "./email";
import { PLAN_IDS, planPrices, type Prices } from "./platform";

/**
 * Assinatura do Spherum: a agência paga o plano e os add-ons ao Spherum, pelo Asaas da conta do
 * Spherum. O servidor gera as faturas (o Asaas só cobra e avisa), aplica cupom e troca de plano e
 * bloqueia quando o teste acaba sem assinatura, quando o atraso passa da carência ou quando a
 * assinatura cancelada chega ao fim do período.
 *
 * - Ciclo mensal ou anual (anual: 12 meses com 20% de desconto, como no site).
 * - Upgrade de plano e add-on novo valem na hora, com uma fatura de ajuste proporcional ao que
 *   falta do período. Plano menor e troca de ciclo valem no próximo período.
 * - A fatura do próximo período sai 5 dias antes do fim do atual. Vencida, a agência tem 7 dias de
 *   carência antes do bloqueio. No fim do teste, 3 dias se já houver fatura em aberto.
 */

export type PlanId = (typeof PLAN_IDS)[number];
const TZ = "America/Sao_Paulo";
export const ANNUAL_FACTOR = 0.8;
export const RENEW_DAYS = 5;
export const GRACE_DAYS = 7;
export const TRIAL_GRACE_DAYS = 3;

/**
 * Limites de cada plano: clientes ativos, pessoas (membros e convites pendentes), xodós e contatos
 * de prospecção por mês vindos das buscas (Google Maps, CNPJ, Instagram e grupos; planilha não conta),
 * como no site. Nulo: sem limite.
 */
export const PLAN_LIMITS: Record<PlanId, { clients: number | null; seats: number | null; xodos: number; prospect: number | null }> = {
  solo: { clients: 5, seats: 1, xodos: 0, prospect: 0 },
  agencia: { clients: 20, seats: 10, xodos: 1, prospect: 500 },
  escala: { clients: 100, seats: 30, xodos: 3, prospect: 3000 },
  rede: { clients: 250, seats: 75, xodos: 5, prospect: 15000 },
  empresarial: { clients: null, seats: null, xodos: 10, prospect: null },
};

/**
 * Add-ons, como no design: preço por mês, a partir de qual plano pode comprar (from) e em qual já vem
 * incluído (incl), máximo (0: liga e desliga). available falso: a funcionalidade ainda não existe.
 */
type Addon = { name: string; price: number; from: number; incl: number | null; max: number; available: boolean };
export const ADDONS: Record<string, Addon> = {
  crm: { name: "CRM com funil e playbooks", price: 79, from: 0, incl: 1, max: 0, available: true },
  score: { name: "Pontuação de leads", price: 39, from: 0, incl: 1, max: 0, available: true },
  prop: { name: "Propostas e contratos com assinatura", price: 59, from: 0, incl: 1, max: 0, available: true },
  pros: { name: "+1.000 contatos de prospecção", price: 89, from: 0, incl: null, max: 10, available: true },
  disp: { name: "Disparos com variação de mensagem", price: 99, from: 1, incl: 2, max: 0, available: true },
  fin: { name: "Financeiro, cobranças e notas", price: 69, from: 0, incl: 1, max: 0, available: true },
  pub: { name: "Publicar no Meta e aprovar criativos", price: 59, from: 0, incl: 1, max: 0, available: true },
  dre: { name: "DRE e rentabilidade por cliente", price: 49, from: 0, incl: 1, max: 0, available: true },
  studio: { name: "+50 peças no Estúdio", price: 49, from: 0, incl: null, max: 10, available: true },
  video: { name: "+10 vídeos no Estúdio", price: 59, from: 1, incl: null, max: 10, available: true },
  radar: { name: "Radar de risco de cancelamento", price: 79, from: 1, incl: 2, max: 0, available: true },
  brand: { name: "Portal e relatórios com sua marca", price: 49, from: 0, incl: 1, max: 0, available: true },
  domain: { name: "Portal no seu próprio domínio", price: 39, from: 1, incl: 2, max: 0, available: true },
  appb: { name: "App com a marca da agência", price: 199, from: 2, incl: 3, max: 0, available: false },
  chat: { name: "Chat da equipe", price: 29, from: 0, incl: 1, max: 0, available: true },
  acad: { name: "Academy e onboarding", price: 39, from: 0, incl: 1, max: 0, available: true },
  auto: { name: "Automações", price: 59, from: 0, incl: 1, max: 0, available: true },
  tk: { name: "Chamados com prazo", price: 39, from: 1, incl: 2, max: 0, available: true },
  gam: { name: "Conquistas da equipe", price: 29, from: 1, incl: 2, max: 0, available: true },
  xodo: { name: "Xodó a mais", price: 149, from: 0, incl: null, max: 10, available: true },
  seat: { name: "Pessoa a mais", price: 29, from: 0, incl: null, max: 20, available: true },
  clients: { name: "+5 clientes", price: 59, from: 0, incl: null, max: 20, available: true },
  storage: { name: "+25 GB de armazenamento", price: 19, from: 0, incl: null, max: 20, available: true },
  api: { name: "API e webhooks", price: 149, from: 2, incl: 3, max: 0, available: true },
  sso: { name: "Login único (SSO) e auditoria", price: 299, from: 3, incl: 4, max: 0, available: false },
};

export const rankOf = (plan: string) => Math.max(0, PLAN_IDS.indexOf(plan as PlanId));
/** "buy": pode contratar; "incl": já vem no plano; "lock": só a partir de um plano maior. */
export const addonState = (a: Addon, rank: number) => (a.incl != null && rank >= a.incl ? "incl" : rank < a.from ? "lock" : "buy");

export type SubDeps = {
  sql: Sql;
  mail: Mailer;
  appUrl: string;
  /** Conta Asaas do Spherum. Nulo: a cobrança ainda não foi configurada. */
  billing: { provider: PaymentProvider; ctx: ProviderCtx } | null;
};

export function subDepsFromEnv(sql: Sql, mail: Mailer, env: Record<string, string | undefined> = process.env): SubDeps {
  const key = env.ASAAS_SPHERUM_API_KEY;
  return {
    sql, mail, appUrl: env.APP_URL || "https://spherum.com.br",
    billing: key ? { provider: asaas, ctx: { creds: { api_key: key }, env: env.ASAAS_SPHERUM_ENV === "producao" ? "producao" : "teste", http: fetch } } : null,
  };
}

// ---------------------------------------------------------------------------
// Datas e valores
// ---------------------------------------------------------------------------

const today = (now: Date) => dayIn(TZ, now);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export function addMonths(day: string, n: number) {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
/** Meia-noite de Brasília de um dia (fim de período). */
const startOf = (day: string) => new Date(`${day}T00:00:00-03:00`);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

type AgencyRow = {
  id: string; name: string; plan: PlanId; plan_status: string; billing_cycle: "mensal" | "anual"; trial_ends_at: string | null;
  current_period_end: string | null; cancel_at_period_end: boolean; pending_plan: PlanId | null; pending_cycle: "mensal" | "anual" | null;
  custom_price_cents: number | null; locked_at: string | null; locked_reason: string | null; suspended_at: string | null;
  billing_customer_id: string | null; billing_email: string | null; billing_document: string | null; cnpj: string | null; phone: string | null;
};

async function agencyOf(sql: Sql, agencyId: string, lock = false) {
  const a = await one<AgencyRow>(sql,
    `select id, name, plan, plan_status, billing_cycle, trial_ends_at::text, current_period_end::text, cancel_at_period_end, pending_plan, pending_cycle,
            custom_price_cents, locked_at::text, locked_reason, suspended_at::text, billing_customer_id, billing_email, billing_document, cnpj, phone
       from agencies where id = $1${lock ? " for update" : ""}`, [agencyId]);
  if (!a) throw new XodoError("Agência não encontrada.", 404);
  return a;
}

async function addonsOf(sql: Sql, agencyId: string) {
  const rows = await sql.query<{ addon_id: string; qty: number }>(`select addon_id, qty from agency_addons where agency_id = $1`, [agencyId]);
  return Object.fromEntries(rows.map((r) => [r.addon_id, r.qty])) as Record<string, number>;
}

type Line = { k: string; l: string; qty: number; cents: number };

/** Itens de um mês: plano (de tabela ou combinado) e os add-ons cobrados (os incluídos no plano não entram). */
function monthlyLines(plan: PlanId, prices: Prices, custom: number | null, addons: Record<string, number>): Line[] {
  if (plan === "empresarial" && !custom) throw new XodoError("O plano Empresarial é sob contrato. Fale com a gente pelo suporte para combinar o valor.", 400);
  const rank = rankOf(plan);
  const lines: Line[] = [{ k: `plano:${plan}`, l: `Plano ${planName(plan)}`, qty: 1, cents: custom ?? Math.round(prices[plan] * 100) }];
  for (const [id, qty] of Object.entries(addons)) {
    const a = ADDONS[id];
    if (!a || !qty || addonState(a, rank) !== "buy") continue;
    lines.push({ k: `addon:${id}`, l: a.name, qty, cents: a.price * 100 * qty });
  }
  return lines;
}
const sum = (lines: Line[]) => lines.reduce((t, l) => t + l.cents, 0);
export const planName = (p: string) => ({ solo: "Solo", agencia: "Agência", escala: "Escala", rede: "Rede", empresarial: "Empresarial" })[p] ?? p;

type Coupon = { code: string; kind: "pct" | "brl"; value: number; months: number; plans: string[]; max_uses: number | null; uses: number; valid_until: string | null; status: string };

async function couponFor(sql: Sql, code: string, plan: PlanId, now: Date) {
  const c = await one<Coupon>(sql, `select code, kind, value::float8 as value, months, plans, max_uses, uses, valid_until::text, status from coupons where code = $1`, [code.trim().toUpperCase()]);
  if (!c || c.status !== "active") throw new XodoError("Cupom não encontrado ou encerrado.", 404);
  if (c.valid_until && c.valid_until < today(now)) throw new XodoError("Esse cupom venceu.", 409);
  if (c.max_uses != null && c.uses >= c.max_uses) throw new XodoError("Esse cupom já foi usado o máximo de vezes.", 409);
  if (c.plans.length && !c.plans.includes(plan)) throw new XodoError(`Esse cupom vale só para ${c.plans.map(planName).join(", ")}.`, 409);
  return c;
}

/**
 * Desconto de uma fatura com o cupom nos meses cobertos: porcentagem (no anual, só sobre a fração do
 * ano coberta) ou valor fixo por mês.
 */
function discountOf(c: Pick<Coupon, "kind" | "value">, subtotal: number, months: number, cycle: "mensal" | "anual") {
  const share = cycle === "anual" ? Math.min(12, months) / 12 : 1;
  const d = c.kind === "pct" ? Math.round((subtotal * share * c.value) / 100) : Math.round(c.value * 100) * months;
  return Math.min(subtotal, Math.max(0, d));
}
const couponMonths = (cycle: "mensal" | "anual", left: number) => (cycle === "anual" ? Math.min(12, left) : 1);

/** Valor de um período no ciclo: o anual é 12 meses com 20% de desconto. */
function periodLines(lines: Line[], cycle: "mensal" | "anual"): Line[] {
  if (cycle === "mensal") return lines;
  return lines.map((l) => ({ ...l, l: `${l.l} (anual)`, cents: Math.round(l.cents * 12 * ANNUAL_FACTOR) }));
}

// ---------------------------------------------------------------------------
// Situação da assinatura (tela "Plano e cobrança")
// ---------------------------------------------------------------------------

export async function usageOf(sql: Sql, agencyId: string) {
  const u = await one<{ clients: number; seats: number; xodos: number }>(sql,
    `select (select count(*)::int from clients where agency_id = $1 and archived_at is null and status <> 'encerrado') as clients,
            (select count(*)::int from agency_members where agency_id = $1)
              + (select count(*)::int from invites where agency_id = $1 and kind = 'equipe' and accepted_at is null and revoked_at is null and expires_at > now()) as seats,
            (select count(*)::int from xodos where agency_id = $1) as xodos`, [agencyId]);
  return u!;
}

/** Limites que valem agora: os do plano (no teste, os do Agência) mais os add-ons de capacidade. */
export async function limitsOf(sql: Sql, agencyId: string) {
  const a = await one<{ plan: PlanId; plan_status: string }>(sql, `select plan, plan_status from agencies where id = $1`, [agencyId]);
  const plan: PlanId = a?.plan_status === "trial" ? "agencia" : (a?.plan ?? "agencia");
  const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS.agencia;
  const ad = await addonsOf(sql, agencyId);
  const rank = rankOf(plan);
  const extra = (id: string) => (ADDONS[id] && addonState(ADDONS[id], rank) === "buy" ? ad[id] ?? 0 : 0);
  return {
    plan,
    clients: base.clients == null ? null : base.clients + 5 * extra("clients"),
    seats: base.seats == null ? null : base.seats + extra("seat"),
    xodos: base.xodos + extra("xodo"),
    prospect: base.prospect == null ? null : base.prospect + 1000 * extra("pros"),
    studio_images: 50 * extra("studio"),
    studio_videos: 10 * extra("video"),
  };
}

/**
 * API e webhooks: vêm no Rede e no Empresarial; no Escala, com o add-on. No teste, como em
 * limitsOf, vale o plano Agência (sem API).
 */
export async function apiEnabled(sql: Sql, agencyId: string): Promise<boolean> {
  const a = await one<{ plan: PlanId; plan_status: string }>(sql, `select plan, plan_status from agencies where id = $1`, [agencyId]);
  if (!a) return false;
  const st = addonState(ADDONS.api, rankOf(a.plan_status === "trial" ? "agencia" : a.plan));
  if (st !== "buy") return st === "incl";
  return ((await addonsOf(sql, agencyId)).api ?? 0) > 0;
}

const LIMIT_MSG = {
  clients: (n: number) => `O seu plano permite ${n} clientes ativos. Encerre um cliente, contrate "+5 clientes" ou mude de plano em Configurações → Plano e cobrança.`,
  seats: (n: number) => `O seu plano permite ${n} ${n === 1 ? "pessoa" : "pessoas"} (contando convites pendentes). Contrate "Pessoa a mais" ou mude de plano em Configurações → Plano e cobrança.`,
  xodos: (n: number) => n === 0 ? `Xodós começam no plano Agência (ou com o add-on "Xodó a mais"). Veja em Configurações → Plano e cobrança.` : `O seu plano permite ${n} ${n === 1 ? "xodó" : "xodós"}. Contrate "Xodó a mais" ou mude de plano em Configurações → Plano e cobrança.`,
};

/** Confere o limite antes de criar um cliente, um convite ou um xodó. */
export async function assertLimit(sql: Sql, agencyId: string, what: "clients" | "seats" | "xodos", adding = 1) {
  const [lim, use] = await Promise.all([limitsOf(sql, agencyId), usageOf(sql, agencyId)]);
  const max = lim[what];
  if (max != null && use[what] + adding > max) throw new XodoError(LIMIT_MSG[what](max), 402);
}

export async function subscriptionView(sql: Sql, agencyId: string, now = new Date()) {
  const [a, addons, prices, invoices, redemption, usage, limits] = await Promise.all([
    agencyOf(sql, agencyId), addonsOf(sql, agencyId), planPrices(sql),
    sql.query<{ id: string; kind: string; plan: string; cycle: string; period_start: string; period_end: string; items: Line[]; subtotal_cents: number; discount_cents: number; amount_cents: number; coupon_code: string | null; due_date: string; status: string; pay_url: string | null; pix_code: string | null; boleto_line: string | null; paid_at: string | null; method: string | null }>(
      `select id, kind, plan, cycle, period_start::text, period_end::text, items, subtotal_cents, discount_cents, amount_cents, coupon_code, due_date::text, status, pay_url, pix_code, boleto_line, paid_at::text, method
         from spherum_invoices where agency_id = $1 order by created_at desc limit 24`, [agencyId]),
    one<{ coupon_code: string; months_left: number; kind: string; value: number }>(sql,
      `select r.coupon_code, r.months_left, c.kind, c.value::float8 as value from coupon_redemptions r join coupons c on c.code = r.coupon_code where r.agency_id = $1`, [agencyId]),
    usageOf(sql, agencyId), limitsOf(sql, agencyId),
  ]);
  let monthly: number | null = null;
  try { monthly = sum(monthlyLines(a.plan, prices, a.custom_price_cents, addons)); } catch { monthly = null; }
  const trialDays = a.trial_ends_at ? Math.ceil((Date.parse(a.trial_ends_at) - now.getTime()) / 864e5) : null;
  return {
    plan: a.plan, plan_status: a.plan_status, cycle: a.billing_cycle, trial_ends_at: a.trial_ends_at, trial_days_left: a.plan_status === "trial" ? Math.max(0, trialDays ?? 0) : null,
    current_period_end: a.current_period_end, cancel_at_period_end: a.cancel_at_period_end, pending_plan: a.pending_plan, pending_cycle: a.pending_cycle,
    locked: !!a.locked_at, locked_reason: a.locked_reason, custom_price_cents: a.custom_price_cents,
    monthly_cents: monthly, prices, addons, coupon: redemption, invoices, usage, limits,
    billing_email: a.billing_email, billing_document: a.billing_document ?? a.cnpj, configured: true,
  };
}

// ---------------------------------------------------------------------------
// Assinar, trocar de plano, add-ons e cancelar
// ---------------------------------------------------------------------------

const digits = (s: string) => s.replace(/\D/g, "");
export const subscribeInput = z.object({
  plan: z.enum(PLAN_IDS),
  cycle: z.enum(["mensal", "anual"]).default("mensal"),
  coupon: z.string().trim().max(24).optional(),
  document: z.string().transform(digits).pipe(z.string().regex(/^(\d{11}|\d{14})$/, "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).")).optional(),
  billing_email: z.email().trim().toLowerCase().max(254).optional(),
});

export async function quote(sql: Sql, agencyId: string, raw: unknown, now = new Date()) {
  const i = subscribeInput.pick({ plan: true, cycle: true, coupon: true }).parse(raw);
  const [a, addons, prices] = await Promise.all([agencyOf(sql, agencyId), addonsOf(sql, agencyId), planPrices(sql)]);
  const lines = periodLines(monthlyLines(i.plan, prices, i.plan === a.plan ? a.custom_price_cents : null, addons), i.cycle);
  const subtotal = sum(lines);
  const red = await one<{ coupon_code: string; months_left: number }>(sql, `select coupon_code, months_left from coupon_redemptions where agency_id = $1`, [agencyId]);
  let discount = 0, coupon: string | null = null;
  const code = red && red.months_left > 0 ? red.coupon_code : i.coupon;
  if (code) {
    const c = await couponFor(sql, code, i.plan, now).catch((e) => { if (red) return null; throw e; });
    if (c) { discount = discountOf(c, subtotal, couponMonths(i.cycle, red?.months_left ?? c.months), i.cycle); coupon = c.code; }
  }
  return { plan: i.plan, cycle: i.cycle, lines, subtotal_cents: subtotal, discount_cents: discount, amount_cents: subtotal - discount, coupon };
}

/**
 * Assina (teste, cancelada ou bloqueada) ou troca de plano (já pagante). Devolve a fatura a pagar,
 * quando houver.
 */
export async function subscribe(deps: SubDeps, agencyId: string, userId: string, raw: unknown, now = new Date()) {
  const i = subscribeInput.parse(raw);
  if (!deps.billing) throw new XodoError("A cobrança do Spherum ainda não está configurada. Fale com o suporte (suporte@spherum.com.br).", 503);
  const a = await agencyOf(deps.sql, agencyId);
  if (a.suspended_at) throw new XodoError("Esta agência está suspensa. Fale com o suporte do Spherum (suporte@spherum.com.br).", 403);
  const paying = a.plan_status === "active" || a.plan_status === "past_due";
  if (i.document || i.billing_email) {
    await deps.sql.query(`update agencies set billing_document = coalesce($2, billing_document), billing_email = coalesce($3, billing_email) where id = $1`, [agencyId, i.document ?? null, i.billing_email ?? null]);
  }
  if (paying && a.current_period_end && Date.parse(a.current_period_end) > now.getTime()) return changePlan(deps, a, userId, i, now);
  await assertFits(deps.sql, agencyId, i.plan);

  // Fatura do primeiro período: começa hoje ou no fim do teste (o que vier depois) e vence nesse dia.
  const start = a.plan_status === "trial" && a.trial_ends_at && Date.parse(a.trial_ends_at) > now.getTime() ? dayIn(TZ, new Date(a.trial_ends_at)) : today(now);
  const inv = await deps.sql.transaction(async (tx) => {
    await agencyOf(tx, agencyId, true);
    // Uma escolha nova substitui a fatura de período em aberto que ainda não foi paga (inclusive a
    // renovação vencida de quem está em atraso: o agendador não a recria, porque há fatura em aberto).
    const open = await cancelInvoices(tx, `agency_id = $1 and kind = 'periodo'`, [agencyId]);
    if (i.coupon) await redeem(tx, agencyId, i.coupon, i.plan, now);
    // O preço combinado é do plano combinado: outro plano volta ao preço de tabela.
    await tx.query(`update agencies set plan = $2, billing_cycle = $3, pending_plan = null, pending_cycle = null, cancel_at_period_end = false,
                           custom_price_cents = case when plan = $2 then custom_price_cents end where id = $1`, [agencyId, i.plan, i.cycle]);
    const created = await createPeriodInvoice(tx, agencyId, i.plan, i.cycle, start, start, now);
    await audit(tx, { agencyId, actor: userId, action: "assinatura_escolhida", targetType: "agency", targetId: agencyId, summary: `Plano ${planName(i.plan)} ${i.cycle}: ${brl(created.amount_cents)}` });
    return { created, open };
  });
  await cancelCharges(deps, inv.open);
  return chargeAndNotify(deps, inv.created.id);
}

export const billingInfoInput = z.object({
  document: z.string().transform(digits).pipe(z.string().regex(/^(\d{11}|\d{14})$/, "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).")),
  billing_email: z.email().trim().toLowerCase().max(254).nullable().optional(),
});

/** CPF ou CNPJ e e-mail das faturas. Mudar o documento cria um cadastro novo no Asaas na próxima fatura. */
export async function setBillingInfo(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const i = billingInfoInput.parse(raw);
  const a = await agencyOf(sql, agencyId);
  const changed = (a.billing_document ?? a.cnpj) !== i.document;
  await sql.query(`update agencies set billing_document = $2, billing_email = $3, billing_customer_id = case when $4 then null else billing_customer_id end where id = $1`,
    [agencyId, i.document, i.billing_email ?? null, changed]);
  await audit(sql, { agencyId, actor: userId, action: "assinatura_dados", targetType: "agency", targetId: agencyId, summary: "Dados de cobrança atualizados" });
}

/** Plano menor que o uso atual: recusa antes de cobrar. */
async function assertFits(sql: Sql, agencyId: string, plan: PlanId) {
  const [use, ad] = await Promise.all([usageOf(sql, agencyId), addonsOf(sql, agencyId)]);
  const base = PLAN_LIMITS[plan];
  const extra = (id: string) => (addonState(ADDONS[id], rankOf(plan)) === "buy" ? ad[id] ?? 0 : 0);
  const clients = base.clients == null ? null : base.clients + 5 * extra("clients");
  const seats = base.seats == null ? null : base.seats + extra("seat");
  const xodos = base.xodos + extra("xodo");
  if (clients != null && use.clients > clients) throw new XodoError(`Vocês têm ${use.clients} clientes ativos e o plano ${planName(plan)} permite ${clients}. Encerre clientes ou escolha outro plano.`, 409);
  if (seats != null && use.seats > seats) throw new XodoError(`Vocês têm ${use.seats} pessoas (com convites pendentes) e o plano ${planName(plan)} permite ${seats}. Remova pessoas ou escolha outro plano.`, 409);
  if (use.xodos > xodos) throw new XodoError(`Vocês têm ${use.xodos} xodós e o plano ${planName(plan)} permite ${xodos}. Apague xodós ou escolha outro plano.`, 409);
}

async function redeem(tx: Sql, agencyId: string, code: string, plan: PlanId, now: Date) {
  const had = await one<{ coupon_code: string }>(tx, `select coupon_code from coupon_redemptions where agency_id = $1`, [agencyId]);
  if (had) {
    if (had.coupon_code === code.trim().toUpperCase()) return;
    throw new XodoError(`Esta agência já usou o cupom ${had.coupon_code}. Só vale um cupom por agência.`, 409);
  }
  const c = await couponFor(tx, code, plan, now);
  const used = await one(tx, `update coupons set uses = uses + 1 where code = $1 and status = 'active' and (max_uses is null or uses < max_uses) returning code`, [c.code]);
  if (!used) throw new XodoError("Esse cupom já foi usado o máximo de vezes.", 409);
  await tx.query(`insert into coupon_redemptions (agency_id, coupon_code, months_left) values ($1, $2, $3)`, [agencyId, c.code, c.months]);
}

/**
 * Fatura de um período, com o cupom que ainda vale (desconta um mês, ou até 12 no anual). O preço
 * combinado só vale para o plano atual da agência (como no quote).
 */
async function createPeriodInvoice(tx: Sql, agencyId: string, plan: PlanId, cycle: "mensal" | "anual", start: string, due: string, now: Date) {
  const [a, addons, prices] = await Promise.all([agencyOf(tx, agencyId), addonsOf(tx, agencyId), planPrices(tx)]);
  const lines = periodLines(monthlyLines(plan, prices, plan === a.plan ? a.custom_price_cents : null, addons), cycle);
  const subtotal = sum(lines);
  const red = await one<{ coupon_code: string; months_left: number; kind: "pct" | "brl"; value: number }>(tx,
    `select r.coupon_code, r.months_left, c.kind, c.value::float8 as value from coupon_redemptions r join coupons c on c.code = r.coupon_code where r.agency_id = $1 and r.months_left > 0 for update of r`, [agencyId]);
  let discount = 0, months = 0;
  if (red) {
    months = couponMonths(cycle, red.months_left);
    discount = discountOf(red, subtotal, months, cycle);
    await tx.query(`update coupon_redemptions set months_left = greatest(0, months_left - $2) where agency_id = $1`, [agencyId, months]);
  }
  const end = addMonths(start, cycle === "anual" ? 12 : 1);
  const dueDay = due < today(now) ? today(now) : due;
  const row = await one<{ id: string; amount_cents: number }>(tx,
    `insert into spherum_invoices (agency_id, kind, plan, cycle, period_start, period_end, items, subtotal_cents, discount_cents, amount_cents, coupon_code, coupon_months, due_date)
     values ($1, 'periodo', $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12) returning id, amount_cents`,
    [agencyId, plan, cycle, start, end, json(lines), subtotal, discount, subtotal - discount, red?.coupon_code ?? null, months, dueDay]);
  return row!;
}

type Canceled = { id: string; agency_id: string; charge_id: string | null };

/** Cancela no banco as faturas em aberto que casam com o filtro e devolve ao cupom os meses que elas usaram. */
async function cancelInvoices(tx: Sql, where: string, params: unknown[]) {
  const rows = await tx.query<Canceled & { coupon_code: string | null; coupon_months: number }>(
    `update spherum_invoices set status = 'cancelado' where status in ('pendente', 'vencido') and ${where} returning id, agency_id, charge_id, coupon_code, coupon_months`, params);
  for (const r of rows) {
    if (r.coupon_code && r.coupon_months) await tx.query(`update coupon_redemptions set months_left = months_left + $3 where agency_id = $1 and coupon_code = $2`, [r.agency_id, r.coupon_code, r.coupon_months]);
  }
  return rows;
}

/** Cancela as cobranças no Asaas. A que falhar vai para a fila e o agendador tenta de novo. */
async function cancelCharges(deps: SubDeps, rows: { charge_id: string | null }[]) {
  for (const { charge_id } of rows) {
    if (!charge_id) continue;
    try {
      if (!deps.billing) throw new Error("Cobrança não configurada.");
      await deps.billing.provider.cancel(deps.billing.ctx, charge_id);
    } catch (error) {
      console.error("[assinatura] cancelar cobrança no Asaas falhou", charge_id, error);
      await deps.sql.query(`insert into spherum_charge_cancels (charge_id, error) values ($1, $2) on conflict (charge_id) do update set error = excluded.error, updated_at = now()`,
        [charge_id, (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
    }
  }
}

/**
 * Refaz a fatura de período ainda não começada e não paga (a renovação, ou a primeira no teste) depois
 * de uma troca de plano, ciclo ou add-on: ela foi emitida com o que valia antes.
 */
async function redoUpcoming(deps: SubDeps, agencyId: string, now: Date) {
  const r = await deps.sql.transaction(async (tx) => {
    const a = await agencyOf(tx, agencyId, true);
    const old = await one<{ id: string; period_start: string; due_date: string }>(tx,
      `select id, period_start::text, due_date::text from spherum_invoices where agency_id = $1 and kind = 'periodo' and status = 'pendente' and period_start >= $2::date
        order by period_start desc limit 1`, [agencyId, today(now)]);
    if (!old || a.cancel_at_period_end) return null;
    const canceled = await cancelInvoices(tx, `id = $1`, [old.id]);
    const created = await createPeriodInvoice(tx, agencyId, a.pending_plan ?? a.plan, a.pending_cycle ?? a.billing_cycle, old.period_start, old.due_date, now);
    return { canceled, created };
  });
  if (!r) return null;
  await cancelCharges(deps, r.canceled);
  return chargeAndNotify(deps, r.created.id, now);
}

/** Refaz a próxima fatura sem derrubar a ação que já foi gravada: se a cobrança falhar, o agendador cria depois. */
const redoQuietly = (deps: SubDeps, agencyId: string, now: Date) =>
  redoUpcoming(deps, agencyId, now).catch((error) => { console.error("[assinatura] refazer a próxima fatura falhou", agencyId, error); return null; });

/** Upgrade agora (com ajuste proporcional); plano menor ou outro ciclo no próximo período. */
async function changePlan(deps: SubDeps, a: AgencyRow, userId: string, i: z.infer<typeof subscribeInput>, now: Date) {
  const sameCycle = i.cycle === a.billing_cycle;
  if (i.plan === a.plan && sameCycle) {
    if (a.pending_plan || a.pending_cycle || a.cancel_at_period_end) {
      await deps.sql.query(`update agencies set pending_plan = null, pending_cycle = null, cancel_at_period_end = false where id = $1`, [a.id]);
      await redoQuietly(deps, a.id, now);
      return { invoice: null, message: `Vocês continuam no plano ${planName(a.plan)}.` };
    }
    throw new XodoError("Esse já é o plano de vocês.", 409);
  }
  const up = rankOf(i.plan) > rankOf(a.plan);
  if (up && sameCycle) {
    await assertFits(deps.sql, a.id, i.plan);
    const created = await deps.sql.transaction(async (tx) => {
      // Agência travada e relida aqui: um segundo clique espera o primeiro e não gera outro ajuste.
      const cur = await agencyOf(tx, a.id, true);
      if (rankOf(i.plan) <= rankOf(cur.plan) || cur.billing_cycle !== a.billing_cycle) return null;
      const [prices, addons] = await Promise.all([planPrices(tx), addonsOf(tx, a.id)]);
      const before = sum(periodLines(monthlyLines(cur.plan, prices, cur.custom_price_cents, addons), cur.billing_cycle));
      const after = sum(periodLines(monthlyLines(i.plan, prices, null, addons), cur.billing_cycle));
      await tx.query(`update agencies set plan = $2, custom_price_cents = null, pending_plan = null where id = $1`, [a.id, i.plan]);
      await audit(tx, { agencyId: a.id, actor: userId, action: "assinatura_upgrade", targetType: "agency", targetId: a.id, summary: `Plano ${planName(cur.plan)} → ${planName(i.plan)}` });
      return adjustment(tx, cur, after - before, `Diferença para o plano ${planName(i.plan)}`, i.plan, now);
    });
    await redoQuietly(deps, a.id, now);
    if (!created) return { invoice: null, message: `Pronto: vocês estão no plano ${planName(i.plan)}.` };
    return chargeAndNotify(deps, created.id, now);
  }
  await assertFits(deps.sql, a.id, i.plan);
  await deps.sql.query(`update agencies set pending_plan = $2, pending_cycle = $3, cancel_at_period_end = false where id = $1`, [a.id, i.plan === a.plan ? null : i.plan, sameCycle ? null : i.cycle]);
  await audit(deps.sql, { agencyId: a.id, actor: userId, action: "assinatura_troca_agendada", targetType: "agency", targetId: a.id, summary: `Plano ${planName(i.plan)} ${i.cycle} a partir do próximo período` });
  await redoQuietly(deps, a.id, now);
  return { invoice: null, message: `A troca para o plano ${planName(i.plan)} (${i.cycle}) vale a partir de ${fmtDay(dayIn(TZ, new Date(a.current_period_end!)))}.` };
}

const fmtDay = (d: string) => d.split("-").reverse().join("/");

/** Fatura de ajuste: a diferença (por período) proporcional ao que falta do período atual. */
async function adjustment(tx: Sql, a: AgencyRow, periodDiffCents: number, label: string, plan: PlanId, now: Date) {
  if (periodDiffCents <= 0 || !a.current_period_end) return null;
  const end = dayIn(TZ, new Date(a.current_period_end));
  const start = addMonths(end, a.billing_cycle === "anual" ? -12 : -1);
  const left = Math.max(0, daysBetween(today(now), end)), total = Math.max(1, daysBetween(start, end));
  const cents = Math.round((periodDiffCents * left) / total);
  if (cents < 500) return null; // menos de R$ 5 não vale uma cobrança
  const lines: Line[] = [{ k: "ajuste", l: `${label} (${left} de ${total} dias)`, qty: 1, cents }];
  return (await one<{ id: string }>(tx,
    `insert into spherum_invoices (agency_id, kind, plan, cycle, period_start, period_end, items, subtotal_cents, amount_cents, due_date)
     values ($1, 'ajuste', $2, $3, $4, $5, $6::jsonb, $7, $7, $8) returning id`,
    [a.id, plan, a.billing_cycle, today(now), end, json(lines), cents, addDays(today(now), 3)]))!;
}

export const addonInput = z.object({ addon: z.string().regex(/^[a-z]{2,12}$/), qty: z.number().int().min(0).max(50) });

/** Liga, desliga ou muda a quantidade de um add-on. Com a assinatura paga, o aumento gera ajuste proporcional. */
export async function setAddon(deps: SubDeps, agencyId: string, userId: string, raw: unknown, now = new Date()) {
  const i = addonInput.parse(raw);
  const ad = ADDONS[i.addon];
  if (!ad) throw new XodoError("Add-on desconhecido.", 404);
  const a = await agencyOf(deps.sql, agencyId);
  if (i.qty > 0 && !ad.available) throw new XodoError(`${ad.name} ainda não está disponível. Avisamos quando liberar.`, 409);
  const rank = rankOf(a.plan);
  const st = addonState(ad, rank);
  if (i.qty > 0 && st === "incl") throw new XodoError(`${ad.name} já vem no plano ${planName(a.plan)}.`, 409);
  if (i.qty > 0 && st === "lock") throw new XodoError(`${ad.name} é a partir do plano ${planName(PLAN_IDS[ad.from])}.`, 409);
  const max = ad.max || 1;
  if (i.qty > max) throw new XodoError(`O máximo de ${ad.name} é ${max}.`, 400);
  const cur = (await addonsOf(deps.sql, agencyId))[i.addon] ?? 0;
  if (i.qty === cur) return { invoice: null, message: "Nada mudou." };
  if (i.qty < cur) {
    // Tirar capacidade que está em uso não pode.
    const use = await usageOf(deps.sql, agencyId);
    const lim = await limitsOf(deps.sql, agencyId);
    const drop = cur - i.qty;
    if (i.addon === "clients" && lim.clients != null && use.clients > lim.clients - 5 * drop) throw new XodoError("Vocês estão usando esses clientes. Encerre clientes antes de tirar o pacote.", 409);
    if (i.addon === "seat" && lim.seats != null && use.seats > lim.seats - drop) throw new XodoError("Vocês estão usando essas vagas. Remova pessoas ou convites antes.", 409);
    if (i.addon === "xodo" && use.xodos > lim.xodos - drop) throw new XodoError("Vocês estão usando esses xodós. Apague um xodó antes.", 409);
  }
  const paying = (a.plan_status === "active" || a.plan_status === "past_due") && a.current_period_end && Date.parse(a.current_period_end) > now.getTime();
  const r = await deps.sql.transaction(async (tx) => {
    // Agência travada e quantidade relida aqui: um segundo clique espera o primeiro e não gera outro ajuste.
    const locked = await agencyOf(tx, agencyId, true);
    const had = (await addonsOf(tx, agencyId))[i.addon] ?? 0;
    if (i.qty === had) return { changed: false, created: null };
    if (i.qty === 0) await tx.query(`delete from agency_addons where agency_id = $1 and addon_id = $2`, [agencyId, i.addon]);
    else await tx.query(`insert into agency_addons (agency_id, addon_id, qty) values ($1, $2, $3) on conflict (agency_id, addon_id) do update set qty = excluded.qty, updated_at = now()`, [agencyId, i.addon, i.qty]);
    await audit(tx, { agencyId, actor: userId, action: "assinatura_addon", targetType: "agency", targetId: agencyId, summary: `${ad.name}: ${had} → ${i.qty}` });
    if (!paying || i.qty < had) return { changed: true, created: null };
    const diff = ad.price * 100 * (i.qty - had) * (locked.billing_cycle === "anual" ? 12 * ANNUAL_FACTOR : 1);
    return { changed: true, created: await adjustment(tx, locked, Math.round(diff), ad.name, locked.plan, now) };
  });
  if (!r.changed) return { invoice: null, message: "Nada mudou." };
  // A próxima fatura já emitida (renovação ou a primeira) passa a ter o add-on novo.
  await redoQuietly(deps, agencyId, now);
  const created = r.created;
  if (!created) return { invoice: null, message: i.qty > cur ? `${ad.name} ativado${paying ? "" : "; entra na primeira fatura"}.` : `${ad.name} ${i.qty ? "reduzido" : "removido"}; sai da próxima fatura.` };
  return chargeAndNotify(deps, created.id, now);
}

/** Cancela no fim do período (ou desfaz). No teste, só cancela a fatura em aberto. */
export async function cancelSubscription(deps: SubDeps, agencyId: string, userId: string, raw: unknown, now = new Date()) {
  const { resume } = z.object({ resume: z.boolean().default(false) }).parse(raw ?? {});
  const a = await agencyOf(deps.sql, agencyId);
  if (resume) {
    await deps.sql.query(`update agencies set cancel_at_period_end = false where id = $1`, [agencyId]);
    await audit(deps.sql, { agencyId, actor: userId, action: "assinatura_mantida", targetType: "agency", targetId: agencyId });
    return { message: "A assinatura continua." };
  }
  if (a.plan_status === "active" || a.plan_status === "past_due") {
    await deps.sql.query(`update agencies set cancel_at_period_end = true where id = $1`, [agencyId]);
    // Renovação já gerada e não paga deixa de valer.
    const open = await cancelInvoices(deps.sql, `agency_id = $1 and kind = 'periodo' and status = 'pendente' and period_start >= $2::date`,
      [agencyId, a.current_period_end ? dayIn(TZ, new Date(a.current_period_end)) : today(now)]);
    await cancelCharges(deps, open);
    await audit(deps.sql, { agencyId, actor: userId, action: "assinatura_cancelada", targetType: "agency", targetId: agencyId, summary: "Cancela no fim do período" });
    return { message: a.current_period_end ? `A assinatura fica ativa até ${fmtDay(dayIn(TZ, new Date(a.current_period_end)))} e não renova.` : "A assinatura não renova." };
  }
  await cancelCharges(deps, await cancelInvoices(deps.sql, `agency_id = $1`, [agencyId]));
  return { message: "Fatura em aberto cancelada." };
}

// ---------------------------------------------------------------------------
// Cobrança no Asaas, pagamento e avisos
// ---------------------------------------------------------------------------

/** Cria a cobrança no Asaas (se ainda não existe), avisa por e-mail e devolve a fatura com o link. */
async function chargeAndNotify(deps: SubDeps, invoiceId: string, now = new Date()) {
  const inv = await createCharge(deps, invoiceId, now);
  const due = inv.due_date < today(now) ? today(now) : inv.due_date;
  if (inv.amount_cents > 0 && inv.pay_url) await mailLeaders(deps, inv.agency_id, `Fatura do Spherum: ${brl(inv.amount_cents)}`,
    `Sua fatura do Spherum de ${brl(inv.amount_cents)} vence em ${fmtDay(due)}.\n\nPague por Pix, boleto ou cartão: ${inv.pay_url}\n\nAs faturas ficam em Configurações → Plano e cobrança.`);
  return { invoice: inv, message: inv.amount_cents > 0 ? "Fatura gerada." : "Sem valor a pagar." };
}

type InvoiceRow = { id: string; agency_id: string; kind: string; plan: PlanId; cycle: "mensal" | "anual"; period_start: string; period_end: string; amount_cents: number; due_date: string; status: string; charge_id: string | null; pay_url: string | null; pix_code: string | null; boleto_line: string | null };
const INVOICE_COLS = `id, agency_id, kind, plan, cycle, period_start::text, period_end::text, amount_cents, due_date::text, status, charge_id, pay_url, pix_code, boleto_line`;
const invoiceById = async (sql: Sql, id: string) => (await one<InvoiceRow>(sql, `select ${INVOICE_COLS} from spherum_invoices where id = $1`, [id]))!;

/** Fatura em aberto (pendente ou vencida) sem cobrança ganha uma no Asaas, que vence hoje se a fatura já venceu. */
async function createCharge(deps: SubDeps, invoiceId: string, now = new Date()): Promise<InvoiceRow> {
  const inv = await invoiceById(deps.sql, invoiceId);
  if (inv.charge_id || (inv.status !== "pendente" && inv.status !== "vencido")) return inv;
  // Fatura zerada (cupom de 100%): já vale como paga.
  if (inv.amount_cents === 0) { await applyState(deps, inv, { status: "pago", paidCents: 0, method: "cupom" }, now); return invoiceById(deps.sql, invoiceId); }
  if (!deps.billing) throw new XodoError("A cobrança do Spherum ainda não está configurada.", 503);
  const a = await agencyOf(deps.sql, inv.agency_id);
  const email = a.billing_email ?? (await one<{ email: string | null }>(deps.sql,
    `select u.email from agency_members m join auth.users u on u.id = m.user_id where m.agency_id = $1 and m.role = 'owner' order by m.created_at limit 1`, [inv.agency_id]))?.email ?? null;
  const doc = a.billing_document ?? a.cnpj;
  if (!doc && !a.billing_customer_id) throw new XodoError("Informe o CPF ou o CNPJ de quem paga para gerar a fatura.", 400);
  let c;
  try {
    c = await deps.billing.provider.createCharge(deps.billing.ctx, {
      invoiceId: inv.id, amountCents: inv.amount_cents, dueDate: inv.due_date < today(now) ? today(now) : inv.due_date, methods: ["pix", "boleto", "cartao"],
      description: `Spherum · ${inv.kind === "ajuste" ? "ajuste" : `plano ${planName(inv.plan)} ${inv.cycle}`} · ${fmtDay(inv.period_start)} a ${fmtDay(addDays(inv.period_end, -1))}`,
      payer: { name: a.name, email, document: doc, phone: a.phone }, customerId: a.billing_customer_id,
      notifyUrl: `${deps.appUrl}/api/spherum/asaas`, returnUrl: `${deps.appUrl}/agencia`,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await deps.sql.query(`update spherum_invoices set error = $2 where id = $1`, [inv.id, msg.slice(0, 500)]);
    if (error instanceof IntegrationError || error instanceof XodoError) throw new XodoError(`Não deu para gerar a cobrança no Asaas: ${msg}`, 502);
    throw error;
  }
  if (c.customerId && c.customerId !== a.billing_customer_id) await deps.sql.query(`update agencies set billing_customer_id = $2 where id = $1`, [a.id, c.customerId]);
  const row = await one<InvoiceRow>(deps.sql, `update spherum_invoices set charge_id = $2, pay_url = $3, pix_code = $4, boleto_line = $5, error = null
      where id = $1 and status in ('pendente', 'vencido') and charge_id is null returning ${INVOICE_COLS}`,
    [inv.id, c.chargeId, c.paymentUrl ?? null, c.pixCode ?? null, c.boletoLine ?? null]);
  if (row) return row;
  // A fatura foi cancelada (ou ganhou outra cobrança) enquanto esta era criada: a nova não vale.
  await cancelCharges(deps, [{ charge_id: c.chargeId }]);
  return invoiceById(deps.sql, invoiceId);
}

/**
 * Aplica o status que o Asaas informou. Pagamento de período libera e estende a assinatura; estorno
 * devolve o período. Vencida não volta a pendente, e fatura cancelada que foi paga vira crédito para o
 * admin resolver (não reativa nada).
 */
async function applyState(deps: SubDeps, inv: InvoiceRow, st: ChargeState, now = new Date()) {
  const next = st.status === "pago" ? "pago" : st.status === "vencido" ? "vencido" : st.status === "cancelado" ? "cancelado" : st.status === "estornado" ? "estornado" : "pendente";
  if (next === inv.status || inv.status === "estornado" || (inv.status === "vencido" && next === "pendente")) return false;
  if (inv.status === "cancelado") return next === "pago" ? paidAfterCancel(deps, inv, st) : false;
  const result = await deps.sql.transaction(async (tx) => {
    const row = await one<{ status: string }>(tx, `update spherum_invoices set status = $2, paid_at = case when $2 = 'pago' then coalesce($3::timestamptz, now()) else paid_at end, method = coalesce($4, method)
      where id = $1 and status = $5 returning status`, [inv.id, next, st.paidAt ?? null, st.method ?? null, inv.status]);
    if (!row) return null;
    // Cancelada no Asaas sem pagar: os meses do cupom voltam.
    if (next === "cancelado") await tx.query(`update coupon_redemptions r set months_left = r.months_left + i.coupon_months from spherum_invoices i
      where i.id = $1 and r.agency_id = i.agency_id and r.coupon_code = i.coupon_code and i.coupon_months > 0`, [inv.id]);
    if (inv.status === "pago") { if (inv.kind === "periodo") await reversePeriod(tx, inv, now); return "estorno"; }
    if (next !== "pago") return null;
    const a = await agencyOf(tx, inv.agency_id, true);
    const day = today(now);
    // Outras faturas vencidas: a agência continua em atraso (e bloqueada, se passaram da carência).
    const late = await one<{ any: boolean; grace: boolean }>(tx,
      `select count(*) > 0 as any, coalesce(bool_or(due_date < $3::date - ${GRACE_DAYS}), false) as grace from spherum_invoices where agency_id = $1 and id <> $2 and status = 'vencido'`, [inv.agency_id, inv.id, day]);
    if (inv.kind === "periodo") {
      // Período que já tinha acabado quando foi pago (sem outro período pago depois): recomeça no dia do
      // pagamento, sem cobrar os meses parados.
      const payDay = dayIn(TZ, st.paidAt ? new Date(st.paidAt) : now);
      const covered = a.current_period_end && Date.parse(a.current_period_end) > startOf(payDay).getTime();
      const endDay = inv.period_end <= payDay && !covered ? addMonths(payDay, inv.cycle === "anual" ? 12 : 1) : inv.period_end;
      // Plano e ciclo da fatura valem na assinatura nova e na troca agendada; uma troca feita depois da emissão (upgrade) fica.
      const fresh = a.plan_status !== "active" && a.plan_status !== "past_due";
      const plan = fresh || a.pending_plan === inv.plan ? inv.plan : a.plan;
      const cycle = fresh || a.pending_cycle === inv.cycle ? inv.cycle : a.billing_cycle;
      const end = startOf(endDay).toISOString();
      await tx.query(
        `update agencies set plan = $2, billing_cycle = $3, plan_status = $5,
                current_period_end = greatest(coalesce(current_period_end, $4::timestamptz), $4::timestamptz),
                custom_price_cents = case when plan = $2 then custom_price_cents end,
                pending_plan = case when pending_plan = $2 then null else pending_plan end,
                pending_cycle = case when pending_cycle = $3 then null else pending_cycle end,
                locked_at = case when $6 and locked_reason = 'atraso' then locked_at end,
                locked_reason = case when $6 and locked_reason = 'atraso' then locked_reason end
          where id = $1`, [inv.agency_id, plan, cycle, end, late!.any ? "past_due" : "active", late!.grace]);
      if (endDay !== inv.period_end) await audit(tx, { agencyId: inv.agency_id, actor: null, action: "assinatura_periodo_recomecado", targetType: "spherum_invoice", targetId: inv.id, summary: `Período pago depois do fim: vale de ${fmtDay(payDay)} a ${fmtDay(endDay)}` });
    } else if (!late!.any && a.current_period_end && Date.parse(a.current_period_end) > now.getTime()) {
      // Ajuste pago e nada mais em aberto: sai do atraso e do bloqueio por atraso.
      await tx.query(`update agencies set plan_status = case when plan_status = 'past_due' then 'active' else plan_status end,
                             locked_at = case when locked_reason = 'atraso' then null else locked_at end,
                             locked_reason = case when locked_reason = 'atraso' then null else locked_reason end where id = $1`, [inv.agency_id]);
    }
    await audit(tx, { agencyId: inv.agency_id, actor: null, action: "assinatura_paga", targetType: "spherum_invoice", targetId: inv.id, summary: `Fatura de ${brl(inv.amount_cents)} paga` });
    return "pago";
  });
  if (result === "pago") {
    await notify(deps.sql, inv.agency_id, "assinatura_paga", "Pagamento confirmado", `Recebemos ${brl(inv.amount_cents)}. Obrigado!`);
    await mailLeaders(deps, inv.agency_id, "Pagamento confirmado · Spherum", `Recebemos o pagamento de ${brl(inv.amount_cents)}. Obrigado por usar o Spherum!`);
  }
  return result !== null;
}

/**
 * Estorno ou chargeback de um período pago: a assinatura perde esse período (o fim volta um ciclo) e,
 * se ele já começou, a agência fica em atraso; o bloqueio segue a carência a partir do novo fim.
 */
async function reversePeriod(tx: Sql, inv: InvoiceRow, now: Date) {
  const a = await agencyOf(tx, inv.agency_id, true);
  if (!a.current_period_end) return;
  const back = startOf(addMonths(dayIn(TZ, new Date(a.current_period_end)), inv.cycle === "anual" ? -12 : -1));
  await tx.query(`update agencies set current_period_end = $2::timestamptz, plan_status = case when plan_status = 'active' and $2::timestamptz <= $3::timestamptz then 'past_due' else plan_status end where id = $1`,
    [inv.agency_id, back.toISOString(), now.toISOString()]);
  await audit(tx, { agencyId: inv.agency_id, actor: null, action: "assinatura_estornada", targetType: "spherum_invoice", targetId: inv.id, summary: `Fatura de ${brl(inv.amount_cents)} estornada: período vai até ${fmtDay(dayIn(TZ, back))}` });
}

/** Fatura cancelada que mesmo assim foi paga no Asaas: fica registrada como crédito e o admin é avisado (em Receita e na auditoria). */
async function paidAfterCancel(deps: SubDeps, inv: InvoiceRow, st: ChargeState) {
  const row = await one(deps.sql, `update spherum_invoices set paid_at = coalesce($2::timestamptz, now()), method = coalesce($3, method),
      error = $4 where id = $1 and status = 'cancelado' and paid_at is null returning id`,
    [inv.id, st.paidAt ?? null, st.method ?? null, `Paga depois de cancelada: crédito de ${brl(st.paidCents ?? inv.amount_cents)} a devolver ou abater`]);
  if (!row) return false;
  await audit(deps.sql, { agencyId: inv.agency_id, actor: null, action: "assinatura_paga_cancelada", targetType: "spherum_invoice", targetId: inv.id, summary: `Fatura cancelada paga no Asaas (${brl(st.paidCents ?? inv.amount_cents)}): crédito para o admin resolver` });
  console.error("[assinatura] fatura cancelada foi paga", inv.id);
  await staffAlert(deps.sql, deps.mail, {
    key: `asaas:pago-cancelado:${inv.id}`,
    subject: "Uma agência pagou uma fatura já cancelada",
    text: `A fatura ${inv.id} foi paga no Asaas depois de cancelada (${brl(st.paidCents ?? inv.amount_cents)}). O valor virou crédito: devolva ou abata na próxima fatura em Receita, no admin.`,
    cooldownHours: 24 * 365,
  }).catch((error) => console.error("[assinatura] alerta falhou", error));
  return true;
}

async function notify(sql: Sql, agencyId: string, kind: string, title: string, body: string) {
  await sql.query(`insert into notifications (agency_id, kind, title, body, data) values ($1, $2, $3, $4, '{}'::jsonb)`, [agencyId, kind, title, body.slice(0, 500)]);
}

async function mailLeaders(deps: SubDeps, agencyId: string, subject: string, text: string) {
  const a = await one<{ billing_email: string | null }>(deps.sql, `select billing_email from agencies where id = $1`, [agencyId]);
  const rows = await deps.sql.query<{ email: string | null }>(
    `select u.email from agency_members m join auth.users u on u.id = m.user_id where m.agency_id = $1 and m.role in ('owner', 'admin', 'financeiro') and u.email is not null`, [agencyId]);
  const to = [...new Set([a?.billing_email, ...rows.map((r) => r.email)].filter((e): e is string => !!e))];
  if (to.length) await deps.mail({ to, subject, text: `${text}\n\nEquipe Spherum`, replyTo: "suporte@spherum.com.br" }).catch(() => false);
}

/** Link para pagar de novo (a cobrança do Asaas pode ter sido cancelada ou nunca criada). */
export async function payLink(deps: SubDeps, agencyId: string, invoiceId: string, now = new Date()) {
  const inv = await one<InvoiceRow>(deps.sql, `select ${INVOICE_COLS} from spherum_invoices where id = $1 and agency_id = $2`, [invoiceId, agencyId]);
  if (!inv) throw new XodoError("Fatura não encontrada.", 404);
  if (inv.status !== "pendente" && inv.status !== "vencido") throw new XodoError("Essa fatura não está em aberto.", 409);
  // Com cobrança, o link continua valendo (o Asaas aceita pagar vencida); sem, cria uma que vence hoje.
  return createCharge(deps, inv.id, now);
}

/** Aviso do Asaas (conta do Spherum). O status vale quando o Spherum pergunta de novo ao Asaas. */
export async function handleSpherumWebhook(deps: SubDeps, token: string | null, body: unknown, env: Record<string, string | undefined> = process.env) {
  const expected = env.ASAAS_SPHERUM_WEBHOOK_TOKEN;
  if (!expected || !token || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) throw new XodoError("Token inválido.", 401);
  if (!deps.billing) throw new XodoError("Cobrança não configurada.", 503);
  const parsed = deps.billing.provider.parseWebhook(body, new URLSearchParams());
  if (!parsed?.chargeId) return { ignored: true };
  if (await one(deps.sql, `select 1 from spherum_billing_events where event_id = $1`, [parsed.eventId])) return { duplicate: true };
  const inv = await one<InvoiceRow>(deps.sql, `select ${INVOICE_COLS} from spherum_invoices where charge_id = $1`, [parsed.chargeId]);
  if (inv) {
    const st = await deps.billing.provider.status(deps.billing.ctx, parsed.chargeId, inv.id);
    if (st) await applyState(deps, inv, st);
  }
  // Registrado só depois de processar: se algo falhar no meio, o Asaas reenvia e é processado de novo.
  await deps.sql.query(`insert into spherum_billing_events (event_id) values ($1) on conflict do nothing`, [parsed.eventId]);
  return { ok: true, invoice: inv?.id ?? null };
}

// ---------------------------------------------------------------------------
// Agendador: conferência, renovação, atraso e bloqueio
// ---------------------------------------------------------------------------

const LOCK_MSG: Record<string, [string, string]> = {
  teste: ["Seu teste grátis acabou", "Escolha um plano em Configurações → Plano e cobrança para continuar criando e editando. Seus dados estão guardados."],
  atraso: ["Pagamento em atraso", "A fatura do Spherum passou da carência. Pague em Configurações → Plano e cobrança para liberar a agência."],
  cancelada: ["Assinatura encerrada", "A assinatura chegou ao fim do período. Escolha um plano em Configurações → Plano e cobrança para continuar."],
};

async function lock(deps: SubDeps, agencyId: string, reason: "teste" | "atraso" | "cancelada", now: Date) {
  const r = await one(deps.sql, `update agencies set locked_at = $2, locked_reason = $3, plan_status = case when $3 = 'cancelada' then 'canceled' else plan_status end where id = $1 and locked_at is null returning id`, [agencyId, now.toISOString(), reason]);
  if (!r) return false;
  const [title, body] = LOCK_MSG[reason];
  await notify(deps.sql, agencyId, "assinatura_bloqueio", title, body);
  await mailLeaders(deps, agencyId, `${title} · Spherum`, body);
  await audit(deps.sql, { agencyId, actor: null, action: "assinatura_bloqueio", targetType: "agency", targetId: agencyId, summary: title });
  return true;
}

export async function subscriptionSweep(deps: SubDeps, now = new Date(), opts: { deadline?: number } = {}) {
  const { sql } = deps;
  const out = { refreshed: 0, charged: 0, canceled: 0, overdue: 0, renewed: 0, locked: 0, errors: 0 };
  const left = () => !opts.deadline || Date.now() < opts.deadline;
  const day = today(now);

  // 1. Conferir no Asaas as faturas em aberto que vencem até amanhã (aviso perdido não trava ninguém).
  if (deps.billing) {
    const open = await sql.query<InvoiceRow>(`select ${INVOICE_COLS} from spherum_invoices where status in ('pendente', 'vencido') and charge_id is not null and due_date <= $1::date
      and updated_at < $2::timestamptz - interval '30 minutes' order by due_date limit 30`, [addDays(day, 1), now.toISOString()]);
    for (const inv of open) {
      if (!left()) break;
      try { const st = await deps.billing.provider.status(deps.billing.ctx, inv.charge_id!, inv.id); if (st && (await applyState(deps, inv, st, now))) out.refreshed++; else await sql.query(`update spherum_invoices set updated_at = now() where id = $1`, [inv.id]); }
      catch (error) { out.errors++; console.error("[assinatura] conferência falhou", inv.id, error); }
    }
    // Faturas em aberto sem cobrança (o Asaas falhou na hora): cria de novo, vencendo hoje se já venceu.
    const uncharged = await sql.query<{ id: string }>(`select id from spherum_invoices where status in ('pendente', 'vencido') and charge_id is null
      and updated_at < $1::timestamptz - interval '30 minutes' order by due_date limit 20`, [now.toISOString()]);
    for (const inv of uncharged) {
      if (!left()) break;
      try { await chargeAndNotify(deps, inv.id, now); out.charged++; }
      catch (error) { out.errors++; console.error("[assinatura] cobrança de novo falhou", inv.id, error); }
    }
    // Cobranças que ficaram para cancelar no Asaas.
    const cancels = await sql.query<{ charge_id: string }>(`select charge_id from spherum_charge_cancels where attempts < 20 and updated_at < $1::timestamptz - interval '30 minutes' order by created_at limit 20`, [now.toISOString()]);
    for (const c of cancels) {
      if (!left()) break;
      try { await deps.billing.provider.cancel(deps.billing.ctx, c.charge_id); await sql.query(`delete from spherum_charge_cancels where charge_id = $1`, [c.charge_id]); out.canceled++; }
      catch (error) {
        out.errors++;
        await sql.query(`update spherum_charge_cancels set attempts = attempts + 1, error = $2, updated_at = now() where charge_id = $1`, [c.charge_id, (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
      }
    }
  }

  // 2. Vencidas (período ou ajuste): avisa uma vez e marca a agência como em atraso. Pagante à mão
  // (sem fim de período) fica de fora.
  const overdue = await sql.query<{ id: string; agency_id: string; amount_cents: number; kind: string; pay_url: string | null }>(
    `update spherum_invoices set status = 'vencido' where status = 'pendente' and due_date < $1::date returning id, agency_id, amount_cents, kind, pay_url`, [day]);
  for (const o of overdue) {
    out.overdue++;
    await sql.query(`update agencies set plan_status = 'past_due' where id = $1 and plan_status = 'active' and current_period_end is not null`, [o.agency_id]);
    await notify(sql, o.agency_id, "assinatura_atraso", "Fatura do Spherum vencida", `A fatura de ${brl(o.amount_cents)} venceu. Vocês têm ${GRACE_DAYS} dias antes do bloqueio.`);
    await mailLeaders(deps, o.agency_id, "Fatura do Spherum vencida", `A fatura de ${brl(o.amount_cents)} venceu. Vocês têm ${GRACE_DAYS} dias para pagar antes que a agência seja bloqueada.${o.pay_url ? `\n\nPagar: ${o.pay_url}` : ""}`);
  }

  // 3. Renovação: a fatura do próximo período sai 5 dias antes do fim do atual. Quem já tem fatura de
  // período em aberto (de qualquer início, ex.: reassinou em atraso) não ganha outra.
  const due = await sql.query<{ id: string; current_period_end: string; plan: PlanId; billing_cycle: "mensal" | "anual"; pending_plan: PlanId | null; pending_cycle: "mensal" | "anual" | null }>(
    `select a.id, a.current_period_end::text, a.plan, a.billing_cycle, a.pending_plan, a.pending_cycle from agencies a
      where a.plan_status in ('active', 'past_due') and not a.cancel_at_period_end and a.suspended_at is null
        and a.current_period_end is not null and a.current_period_end <= $1::timestamptz + interval '${RENEW_DAYS} days'
        and not exists (select 1 from spherum_invoices i where i.agency_id = a.id and i.kind = 'periodo' and i.status not in ('cancelado', 'estornado')
                          and (i.period_start = (a.current_period_end at time zone 'America/Sao_Paulo')::date or i.status in ('pendente', 'vencido')))
      order by a.current_period_end limit 50`, [now.toISOString()]);
  for (const a of due) {
    if (!left()) break;
    try {
      const start = dayIn(TZ, new Date(a.current_period_end));
      const created = await sql.transaction((tx) => createPeriodInvoice(tx, a.id, a.pending_plan ?? a.plan, a.pending_cycle ?? a.billing_cycle, start, start, now));
      out.renewed++;
      await chargeAndNotify(deps, created.id, now);
    } catch (error) { out.errors++; console.error("[assinatura] renovação falhou", a.id, error); }
  }

  // 4. Fim do período: cancelada para de vez; não paga fica em atraso (o bloqueio vem depois da carência).
  const ended = await sql.query<{ id: string; cancel_at_period_end: boolean }>(
    `select id, cancel_at_period_end from agencies where plan_status in ('active', 'past_due') and current_period_end is not null and current_period_end <= $1::timestamptz and locked_at is null`, [now.toISOString()]);
  for (const a of ended) {
    if (a.cancel_at_period_end) { if (await lock(deps, a.id, "cancelada", now)) out.locked++; }
    else await sql.query(`update agencies set plan_status = 'past_due' where id = $1 and plan_status = 'active'`, [a.id]);
  }

  // 5. Bloqueios: teste acabou sem pagamento; atraso passou da carência.
  const trialOver = await sql.query<{ id: string }>(
    `select a.id from agencies a where a.plan_status = 'trial' and a.locked_at is null and a.trial_ends_at is not null
        and a.trial_ends_at <= $1::timestamptz - (case when exists (select 1 from spherum_invoices i where i.agency_id = a.id and i.status in ('pendente', 'vencido')) then interval '${TRIAL_GRACE_DAYS} days' else interval '0' end)`,
    [now.toISOString()]);
  for (const a of trialOver) if (await lock(deps, a.id, "teste", now)) out.locked++;
  const late = await sql.query<{ id: string }>(
    `select a.id from agencies a where a.plan_status = 'past_due' and a.locked_at is null
        and ((a.current_period_end is not null and a.current_period_end <= $1::timestamptz - interval '${GRACE_DAYS} days')
          or exists (select 1 from spherum_invoices i where i.agency_id = a.id and i.status = 'vencido' and i.due_date < $2::date - ${GRACE_DAYS}))`,
    [now.toISOString(), day]);
  for (const a of late) if (await lock(deps, a.id, "atraso", now)) out.locked++;
  return out;
}

// ---------------------------------------------------------------------------
// Admin: faturas, estorno e preço combinado
// ---------------------------------------------------------------------------

export async function adminInvoices(sql: Sql) {
  return sql.query<{ id: string; agency_id: string; agency_name: string; kind: string; plan: string; cycle: string; amount_cents: number; discount_cents: number; coupon_code: string | null; due_date: string; status: string; paid_at: string | null; method: string | null; created_at: string; error: string | null }>(
    `select i.id, i.agency_id, a.name as agency_name, i.kind, i.plan, i.cycle, i.amount_cents, i.discount_cents, i.coupon_code, i.due_date::text, i.status, i.paid_at::text, i.method, i.created_at::text, i.error
       from spherum_invoices i join agencies a on a.id = i.agency_id order by i.created_at desc limit 300`);
}

/** Estorno total de uma fatura paga (pelo Asaas) ou cancelamento de uma em aberto. */
export async function adminInvoiceAction(deps: SubDeps, actor: string, invoiceId: string, raw: unknown) {
  const { action, reason } = z.object({ action: z.enum(["refund", "cancel"]), reason: z.string().trim().min(5).max(300) }).parse(raw);
  const inv = await one<InvoiceRow>(deps.sql, `select ${INVOICE_COLS} from spherum_invoices where id = $1`, [invoiceId]);
  if (!inv) throw new XodoError("Fatura não encontrada.", 404);
  if (action === "refund") {
    if (inv.status !== "pago") throw new XodoError("Só dá para estornar fatura paga.", 409);
    if (inv.charge_id && inv.amount_cents > 0) {
      if (!deps.billing) throw new XodoError("Cobrança não configurada.", 503);
      const base = deps.billing.ctx.env === "producao" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
      await requestJson(deps.billing.ctx.http, `${base}/payments/${encodeURIComponent(inv.charge_id)}/refund`, { method: "POST", json: { description: reason }, headers: { access_token: deps.billing.ctx.creds.api_key, "user-agent": "Spherum" } });
    }
    // Mesmo caminho do aviso do Asaas: o período pago sai da assinatura.
    await applyState(deps, inv, { status: "estornado" });
  } else {
    const canceled = await cancelInvoices(deps.sql, `id = $1`, [invoiceId]);
    if (!canceled.length) throw new XodoError("Só dá para cancelar fatura em aberto.", 409);
    await cancelCharges(deps, canceled);
  }
  await audit(deps.sql, { agencyId: inv.agency_id, actor, action: action === "refund" ? "admin_estorno" : "admin_fatura_cancelada", targetType: "spherum_invoice", targetId: invoiceId, summary: `${action === "refund" ? "Estorno" : "Cancelamento"} de ${brl(inv.amount_cents)}: ${reason}` });
}
