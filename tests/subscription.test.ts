import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createCoupon } from "../src/lib/core/admin";
import { createClient } from "../src/lib/core/clients";
import type { EmailMessage } from "../src/lib/core/email";
import { resetPlatformCache, xodoBlocked } from "../src/lib/core/platform";
import {
  addMonths, adminInvoiceAction, cancelSubscription, handleSpherumWebhook, limitsOf, quote, setAddon, subscribe, subscriptionSweep, subscriptionView, type SubDeps,
} from "../src/lib/core/subscription";
import { asaas } from "../src/lib/billing/providers/asaas";
import type { ChargeState, PaymentProvider } from "../src/lib/billing/types";
import { one, type Sql } from "../src/lib/xodos/db";
import { CAN_READ, CAN_USE, requireRole } from "../src/lib/xodos/http";
import { createTestDb, seedClient, seedXodo } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
  resetPlatformCache();
});

/** Asaas de mentira: guarda as cobranças e responde o status que o teste mandar. */
function fakeAsaas() {
  const charges = new Map<string, { amount: number; due: string; customer: string | null }>();
  const states = new Map<string, ChargeState>();
  const canceled: string[] = [];
  const refunds: string[] = [];
  let n = 0;
  const provider: PaymentProvider = {
    ...asaas,
    async createCharge(_ctx, input) {
      const id = `pay_${++n}_${randomUUID().slice(0, 8)}`;
      charges.set(id, { amount: input.amountCents, due: input.dueDate, customer: input.customerId });
      return { chargeId: id, customerId: input.customerId ?? "cus_1", paymentUrl: `https://sandbox.asaas.com/i/${id}`, pixCode: "000201pix" };
    },
    async status(_ctx, id) { return states.get(id) ?? { status: "pendente" }; },
    async cancel(_ctx, id) { canceled.push(id); },
  };
  const http = (async (url: string) => { refunds.push(String(url)); return new Response(JSON.stringify({ id: "x", status: "REFUNDED" }), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  return { provider, http, charges, states, canceled, refunds };
}

async function setup(opts: { trialEnds?: string; plan?: string } = {}) {
  const owner = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`dona-${randomUUID()}@agencia.com`]))!.id;
  const agencyId = (await one<{ id: string }>(sql,
    `insert into agencies (name, plan, cnpj, trial_ends_at) values ($1, $2, '12345678000199', $3) returning id`,
    [`Agência ${randomUUID().slice(0, 6)}`, opts.plan ?? "agencia", opts.trialEnds ?? "2026-11-10T15:00:00Z"]))!.id;
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'owner')`, [agencyId, owner]);
  const fake = fakeAsaas();
  const mails: EmailMessage[] = [];
  const deps: SubDeps = { sql, mail: async (m) => { mails.push(m); return true; }, appUrl: "https://spherum.com.br", billing: { provider: fake.provider, ctx: { creds: { api_key: "$aact_test" }, env: "teste", http: fake.http } } };
  return { agencyId, owner, deps, fake, mails };
}

const agency = (id: string) => one<{ plan: string; plan_status: string; billing_cycle: string; current_period_end: string | null; locked_reason: string | null; pending_plan: string | null; cancel_at_period_end: boolean }>(sql,
  `select plan, plan_status, billing_cycle, current_period_end::text, locked_reason, pending_plan, cancel_at_period_end from agencies where id = $1`, [id]).then((a) => a!);
const invoices = (id: string) => sql.query<{ id: string; kind: string; plan: string; period_start: string; period_end: string; amount_cents: number; discount_cents: number; status: string; charge_id: string | null; due_date: string }>(
  `select id, kind, plan, period_start::text, period_end::text, amount_cents, discount_cents, status, charge_id, due_date::text from spherum_invoices where agency_id = $1 order by created_at`, [id]);
const ENV = { ASAAS_SPHERUM_WEBHOOK_TOKEN: "segredo-do-webhook-123" };
const pay = async (s: Awaited<ReturnType<typeof setup>>, chargeId: string, event = randomUUID()) => {
  s.fake.states.set(chargeId, { status: "pago", paidCents: s.fake.charges.get(chargeId)!.amount, paidAt: "2026-11-10T12:00:00-03:00", method: "pix" });
  return handleSpherumWebhook(s.deps, ENV.ASAAS_SPHERUM_WEBHOOK_TOKEN, { id: event, event: "PAYMENT_RECEIVED", payment: { id: chargeId } }, ENV);
};

test("assinar no teste: fatura começa no fim do teste, cupom de 3 meses; pagamento libera e define o período", async () => {
  const s = await setup();
  const code = `BEM${randomUUID().slice(0, 5).toUpperCase().replace(/-/g, "")}`;
  await createCoupon(sql, { id: s.owner, role: "dono" }, { code, description: "15% por 3 meses", kind: "pct", value: 15, months: 3 });
  const q = await quote(sql, s.agencyId, { plan: "escala", cycle: "mensal", coupon: code });
  assert.deepEqual([q.subtotal_cents, q.discount_cents, q.amount_cents], [99000, 14850, 84150]);

  const now = new Date("2026-11-01T12:00:00Z");
  const r = await subscribe(s.deps, s.agencyId, s.owner, { plan: "escala", cycle: "mensal", coupon: code }, now);
  assert.ok(r.invoice?.pay_url?.includes("asaas"));
  const [inv] = await invoices(s.agencyId);
  assert.deepEqual([inv.period_start, inv.period_end, inv.due_date, inv.amount_cents], ["2026-11-10", "2026-12-10", "2026-11-10", 84150]);
  assert.ok(s.mails.some((m) => /Fatura do Spherum/.test(m.subject)));
  assert.equal((await one<{ months_left: number }>(sql, `select months_left from coupon_redemptions where agency_id = $1`, [s.agencyId]))!.months_left, 2);

  await assert.rejects(handleSpherumWebhook(s.deps, "errado", { id: "e1", payment: { id: inv.charge_id } }, ENV), /Token inválido/);
  const ev = randomUUID();
  await pay(s, inv.charge_id!, ev);
  const a = await agency(s.agencyId);
  assert.deepEqual([a.plan, a.plan_status, a.current_period_end?.slice(0, 10)], ["escala", "active", "2026-12-10"]);
  assert.deepEqual(await handleSpherumWebhook(s.deps, ENV.ASAAS_SPHERUM_WEBHOOK_TOKEN, { id: ev, payment: { id: inv.charge_id } }, ENV), { duplicate: true });
  assert.ok(s.mails.some((m) => /Pagamento confirmado/.test(m.subject)));
});

test("renovação 5 dias antes, sem duplicar; atraso vira bloqueio depois de 7 dias; pagar libera", async () => {
  const s = await setup();
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z"));
  await pay(s, (await invoices(s.agencyId))[0].charge_id!);
  await subscriptionSweep(s.deps, new Date("2026-12-04T12:00:00Z"));
  assert.equal((await invoices(s.agencyId)).length, 1, "ainda não é hora de renovar");
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-06T13:00:00Z"));
  const list = await invoices(s.agencyId);
  assert.equal(list.length, 2, "uma renovação só");
  assert.deepEqual([list[1].period_start, list[1].period_end, list[1].amount_cents], ["2026-12-10", "2027-01-10", 49000]);

  await subscriptionSweep(s.deps, new Date("2026-12-11T12:00:00Z"));
  assert.deepEqual([(await agency(s.agencyId)).plan_status, (await invoices(s.agencyId))[1].status], ["past_due", "vencido"]);
  assert.equal(await requireRole(sql, s.owner, s.agencyId, CAN_USE), "owner", "na carência ainda dá para trabalhar");
  await subscriptionSweep(s.deps, new Date("2026-12-18T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).locked_reason, "atraso");
  await assert.rejects(requireRole(sql, s.owner, s.agencyId, CAN_USE), /em atraso/);
  assert.equal(await requireRole(sql, s.owner, s.agencyId, CAN_READ), "owner", "ler continua");
  assert.equal(await requireRole(sql, s.owner, s.agencyId, CAN_USE, { allowLocked: true }), "owner", "pagar e suporte continuam");
  assert.match((await xodoBlocked(sql, s.agencyId))!, /bloqueada/);

  await pay(s, list[1].charge_id!);
  const a = await agency(s.agencyId);
  assert.deepEqual([a.plan_status, a.locked_reason, a.current_period_end?.slice(0, 10)], ["active", null, "2027-01-10"]);
});

test("upgrade na hora com ajuste proporcional; plano menor no próximo período; anual com 20%", async () => {
  const s = await setup();
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z"));
  await pay(s, (await invoices(s.agencyId))[0].charge_id!);
  // 10/11 a 10/12 (30 dias); em 25/11 faltam 15: metade de (990 - 490).
  const up = await subscribe(s.deps, s.agencyId, s.owner, { plan: "escala" }, new Date("2026-11-25T12:00:00Z"));
  assert.equal(up.invoice?.amount_cents, 25000);
  assert.equal((await agency(s.agencyId)).plan, "escala");
  const down = await subscribe(s.deps, s.agencyId, s.owner, { plan: "solo" }, new Date("2026-11-26T12:00:00Z"));
  assert.match(down.message!, /10\/12\/2026/);
  assert.equal((await agency(s.agencyId)).pending_plan, "solo");
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  const renewal = (await invoices(s.agencyId)).find((i) => i.period_start === "2026-12-10")!;
  assert.deepEqual([renewal.plan, renewal.amount_cents], ["solo", 19000]);
  await pay(s, renewal.charge_id!);
  assert.deepEqual([(await agency(s.agencyId)).plan, (await agency(s.agencyId)).pending_plan], ["solo", null]);

  const yearly = await setup();
  const q = await quote(sql, yearly.agencyId, { plan: "agencia", cycle: "anual" });
  assert.equal(q.amount_cents, Math.round(49000 * 12 * 0.8));
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
});

test("add-on: ativa com ajuste, aumenta o limite e não sai enquanto está em uso; indisponível e incluído são recusados", async () => {
  const s = await setup({ plan: "agencia" });
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z"));
  await pay(s, (await invoices(s.agencyId))[0].charge_id!);
  assert.equal((await limitsOf(sql, s.agencyId)).xodos, 1);
  const r = await setAddon(s.deps, s.agencyId, s.owner, { addon: "xodo", qty: 1 }, new Date("2026-11-25T12:00:00Z"));
  assert.equal(r.invoice?.amount_cents, 7450, "metade do mês de R$ 149");
  assert.equal((await limitsOf(sql, s.agencyId)).xodos, 2);
  await seedXodo(sql, s.agencyId, { name: "Um" });
  await seedXodo(sql, s.agencyId, { name: "Dois" });
  await assert.rejects(setAddon(s.deps, s.agencyId, s.owner, { addon: "xodo", qty: 0 }), /usando esses xodós/);
  await assert.rejects(setAddon(s.deps, s.agencyId, s.owner, { addon: "sso", qty: 1 }), /ainda não está disponível/);
  await assert.rejects(setAddon(s.deps, s.agencyId, s.owner, { addon: "crm", qty: 1 }), /já vem no plano/);
  const renewal = await (async () => { await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z")); return (await invoices(s.agencyId)).find((i) => i.period_start === "2026-12-10")!; })();
  assert.equal(renewal.amount_cents, 49000 + 14900, "o add-on entra na renovação");
});

test("fim do teste: sem assinatura bloqueia; com fatura em aberto espera 3 dias; cancelar encerra no fim do período", async () => {
  const s = await setup({ trialEnds: "2026-11-10T15:00:00Z" });
  await subscriptionSweep(s.deps, new Date("2026-11-10T16:00:00Z"));
  assert.equal((await agency(s.agencyId)).locked_reason, "teste");
  await assert.rejects(requireRole(sql, s.owner, s.agencyId, CAN_USE), /teste grátis acabou/);
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "solo" }, new Date("2026-11-11T12:00:00Z"));
  await pay(s, (await invoices(s.agencyId))[0].charge_id!);
  assert.deepEqual([(await agency(s.agencyId)).plan_status, (await agency(s.agencyId)).locked_reason], ["active", null]);

  const t = await setup({ trialEnds: "2026-11-10T15:00:00Z" });
  await subscribe(t.deps, t.agencyId, t.owner, { plan: "agencia" }, new Date("2026-11-09T12:00:00Z"));
  await subscriptionSweep(t.deps, new Date("2026-11-11T12:00:00Z"));
  assert.equal((await agency(t.agencyId)).locked_reason, null, "boleto pode levar dias para compensar");
  await subscriptionSweep(t.deps, new Date("2026-11-13T16:00:00Z"));
  assert.equal((await agency(t.agencyId)).locked_reason, "teste");

  const c = await setup();
  await subscribe(c.deps, c.agencyId, c.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z"));
  await pay(c, (await invoices(c.agencyId))[0].charge_id!);
  const msg = await cancelSubscription(c.deps, c.agencyId, c.owner, {});
  assert.match(msg.message, /10\/12\/2026/);
  await subscriptionSweep(c.deps, new Date("2026-12-06T12:00:00Z"));
  assert.equal((await invoices(c.agencyId)).length, 1, "cancelada não renova");
  await subscriptionSweep(c.deps, new Date("2026-12-10T04:00:00Z"));
  assert.deepEqual([(await agency(c.agencyId)).plan_status, (await agency(c.agencyId)).locked_reason], ["canceled", "cancelada"]);
});

test("limites do plano no servidor; Empresarial só com preço combinado; estorno pelo admin", async () => {
  const s = await setup({ plan: "solo" });
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "solo" }, new Date("2026-11-01T12:00:00Z"));
  await pay(s, (await invoices(s.agencyId))[0].charge_id!);
  for (let k = 0; k < 5; k++) await seedClient(sql, s.agencyId, `Cliente ${k}`);
  await assert.rejects(createClient(sql, s.agencyId, s.owner, { name: "Sexto", status: "ativo" }), /permite 5 clientes/);
  await setAddon(s.deps, s.agencyId, s.owner, { addon: "clients", qty: 1 }, new Date("2026-11-25T12:00:00Z"));
  await createClient(sql, s.agencyId, s.owner, { name: "Sexto", status: "ativo" });

  await assert.rejects(subscribe(s.deps, s.agencyId, s.owner, { plan: "empresarial" }, new Date("2026-11-26T12:00:00Z")), /sob contrato/);
  const v = await subscriptionView(sql, s.agencyId);
  assert.deepEqual([v.usage.clients, v.limits.clients], [6, 10]);

  const paid = (await invoices(s.agencyId))[0];
  await adminInvoiceAction(s.deps, s.owner, paid.id, { action: "refund", reason: "Cobrado em duplicidade" });
  assert.equal((await invoices(s.agencyId))[0].status, "estornado");
  assert.ok(s.fake.refunds.some((u) => u.endsWith(`/payments/${paid.charge_id}/refund`)));
});
