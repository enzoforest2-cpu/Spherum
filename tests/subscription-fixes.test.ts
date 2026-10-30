import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createCoupon, updateAgencyAdmin } from "../src/lib/core/admin";
import { resetPlatformCache } from "../src/lib/core/platform";
import {
  adminInvoiceAction, cancelSubscription, handleSpherumWebhook, payLink, setAddon, subscribe, subscriptionSweep, type SubDeps,
} from "../src/lib/core/subscription";
import { asaas } from "../src/lib/billing/providers/asaas";
import type { ChargeState, PaymentProvider } from "../src/lib/billing/types";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

// Regressões da revisão da assinatura (reassinar em atraso, pagar atrasado, cupom, estorno etc.).

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
  resetPlatformCache();
});

function fakeAsaas() {
  const charges = new Map<string, { amount: number; due: string }>();
  const states = new Map<string, ChargeState>();
  const canceled: string[] = [];
  const hooks = { failCreate: 0, failCancel: 0, onCreate: null as null | ((invoiceId: string) => Promise<void>) };
  let n = 0;
  const provider: PaymentProvider = {
    ...asaas,
    async createCharge(_ctx, input) {
      if (hooks.failCreate > 0) { hooks.failCreate--; throw new Error("Asaas fora do ar"); }
      if (hooks.onCreate) await hooks.onCreate(input.invoiceId);
      const id = `pay_${++n}_${randomUUID().slice(0, 8)}`;
      charges.set(id, { amount: input.amountCents, due: input.dueDate });
      return { chargeId: id, customerId: input.customerId ?? "cus_1", paymentUrl: `https://sandbox.asaas.com/i/${id}`, pixCode: "000201pix" };
    },
    async status(_ctx, id) { return states.get(id) ?? { status: "pendente" }; },
    async cancel(_ctx, id) {
      if (hooks.failCancel > 0) { hooks.failCancel--; throw new Error("Asaas fora do ar"); }
      canceled.push(id);
    },
  };
  const http = (async () => new Response(JSON.stringify({ id: "x", status: "REFUNDED" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  return { provider, http, charges, states, canceled, hooks };
}

async function setup(opts: { trialEnds?: string; plan?: string } = {}) {
  const owner = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`dona-${randomUUID()}@agencia.com`]))!.id;
  const agencyId = (await one<{ id: string }>(sql,
    `insert into agencies (name, plan, cnpj, trial_ends_at) values ($1, $2, '12345678000199', $3) returning id`,
    [`Agência ${randomUUID().slice(0, 6)}`, opts.plan ?? "agencia", opts.trialEnds ?? "2026-11-10T15:00:00Z"]))!.id;
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'owner')`, [agencyId, owner]);
  const fake = fakeAsaas();
  const deps: SubDeps = { sql, mail: async () => true, appUrl: "https://spherum.com.br", billing: { provider: fake.provider, ctx: { creds: { api_key: "$aact_test" }, env: "teste", http: fake.http } } };
  return { agencyId, owner, deps, fake };
}
type S = Awaited<ReturnType<typeof setup>>;

const agency = (id: string) => one<{ plan: string; plan_status: string; billing_cycle: string; current_period_end: string | null; locked_reason: string | null; custom_price_cents: number | null }>(sql,
  `select plan, plan_status, billing_cycle, (current_period_end at time zone 'America/Sao_Paulo')::date::text as current_period_end, locked_reason, custom_price_cents from agencies where id = $1`, [id]).then((a) => a!);
const invoices = (id: string) => sql.query<{ id: string; kind: string; plan: string; period_start: string; amount_cents: number; subtotal_cents: number; discount_cents: number; status: string; charge_id: string | null; due_date: string; error: string | null }>(
  `select id, kind, plan, period_start::text, amount_cents, subtotal_cents, discount_cents, status, charge_id, due_date::text, error from spherum_invoices where agency_id = $1 order by created_at`, [id]);
const monthsLeft = async (id: string) => (await one<{ m: number }>(sql, `select months_left as m from coupon_redemptions where agency_id = $1`, [id]))!.m;
const ENV = { ASAAS_SPHERUM_WEBHOOK_TOKEN: "segredo-do-webhook-123" };
const hook = (s: S, chargeId: string) => handleSpherumWebhook(s.deps, ENV.ASAAS_SPHERUM_WEBHOOK_TOKEN, { id: randomUUID(), event: "PAYMENT_UPDATED", payment: { id: chargeId } }, ENV);
const pay = (s: S, chargeId: string, paidAt = "2026-11-10T12:00:00-03:00") => {
  s.fake.states.set(chargeId, { status: "pago", paidCents: s.fake.charges.get(chargeId)!.amount, paidAt, method: "pix" });
  return hook(s, chargeId);
};
/** Assina o Agência mensal e paga: período de 10/11 a 10/12/2026. */
async function paying(opts: { plan?: string } = {}) {
  const s = await setup();
  await subscribe(s.deps, s.agencyId, s.owner, { plan: opts.plan ?? "agencia" }, new Date("2026-11-01T12:00:00Z"));
  await pay(s, (await invoices(s.agencyId))[0].charge_id!);
  return s;
}
const coupon = async (owner: string, value: number, months: number) => {
  const code = `C${randomUUID().slice(0, 7).toUpperCase().replace(/-/g, "")}`;
  await createCoupon(sql, { id: owner, role: "dono" }, { code, description: "Cupom de teste", kind: "pct", value, months });
  return code;
};

test("reassinar em atraso não gera a fatura do período antigo de novo", async () => {
  const s = await paying();
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-11T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).plan_status, "past_due");
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia" }, new Date("2026-12-12T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-13T12:00:00Z"));
  const open = (await invoices(s.agencyId)).filter((i) => i.status === "pendente" || i.status === "vencido");
  assert.deepEqual(open.map((i) => i.period_start), ["2026-12-12"], "só a fatura nova fica em aberto");
  await pay(s, open[0].charge_id!, "2026-12-13T12:00:00-03:00");
  const a = await agency(s.agencyId);
  assert.deepEqual([a.plan_status, a.current_period_end], ["active", "2027-01-12"]);
});

test("pagar período já encerrado recomeça no dia do pagamento, sem rebloquear nem cobrar os meses parados", async () => {
  const s = await paying();
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-11T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-18T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).locked_reason, "atraso");
  const renewal = (await invoices(s.agencyId))[1];
  await pay(s, renewal.charge_id!, "2027-01-15T12:00:00-03:00");
  await subscriptionSweep(s.deps, new Date("2027-01-16T12:00:00Z"));
  const a = await agency(s.agencyId);
  assert.deepEqual([a.plan_status, a.locked_reason, a.current_period_end], ["active", null, "2027-02-15"]);
  assert.equal((await invoices(s.agencyId)).length, 2, "nenhuma fatura dos meses bloqueados");
});

test("fatura sem cobrança: o agendador cria de novo (vencida, vence hoje) e o link de pagar funciona", async () => {
  const s = await setup();
  s.fake.hooks.failCreate = 1;
  await assert.rejects(subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z")), /Asaas/);
  const [inv] = await invoices(s.agencyId);
  assert.deepEqual([inv.charge_id, inv.error], [null, "Asaas fora do ar"]);
  s.fake.hooks.failCreate = 1; // a primeira tentativa do agendador também falha
  await subscriptionSweep(s.deps, new Date("2026-11-12T12:00:00Z"));
  assert.equal((await invoices(s.agencyId))[0].status, "vencido");
  const link = await payLink(s.deps, s.agencyId, inv.id, new Date("2026-11-12T13:00:00Z"));
  assert.ok(link.pay_url, "vencida sem cobrança ganha link");
  assert.equal(s.fake.charges.get(link.charge_id!)!.due, "2026-11-12", "a cobrança vence hoje");

  const t = await setup();
  t.fake.hooks.failCreate = 1;
  await assert.rejects(subscribe(t.deps, t.agencyId, t.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z")));
  const r = await subscriptionSweep(t.deps, new Date("2026-11-12T12:00:00Z"));
  assert.equal(r.charged, 1);
  assert.ok((await invoices(t.agencyId))[0].charge_id);
});

test("cupom no anual: porcentagem só sobre os meses cobertos, consome até 12 e devolve ao cancelar", async () => {
  const s = await setup();
  const code = await coupon(s.owner, 50, 3);
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia", cycle: "anual", coupon: code }, new Date("2026-11-01T12:00:00Z"));
  const [inv] = await invoices(s.agencyId);
  assert.equal(inv.discount_cents, Math.round(inv.subtotal_cents * (3 / 12) * 0.5));
  assert.equal(await monthsLeft(s.agencyId), 0);
  await cancelSubscription(s.deps, s.agencyId, s.owner, {});
  assert.equal(await monthsLeft(s.agencyId), 3, "fatura cancelada devolve os meses");

  const t = await setup();
  const long = await coupon(t.owner, 10, 24);
  await subscribe(t.deps, t.agencyId, t.owner, { plan: "agencia", cycle: "anual", coupon: long }, new Date("2026-11-01T12:00:00Z"));
  assert.equal(await monthsLeft(t.agencyId), 12, "o anual usa 12 dos 24 meses");
});

test("preço combinado só vale para o plano combinado", async () => {
  const s = await setup();
  await sql.query(`update agencies set custom_price_cents = 100000 where id = $1`, [s.agencyId]);
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z"));
  const [first] = await invoices(s.agencyId);
  assert.equal(first.amount_cents, 100000);
  await pay(s, first.charge_id!);
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "solo" }, new Date("2026-11-20T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  const renewal = (await invoices(s.agencyId)).find((i) => i.period_start === "2026-12-10")!;
  assert.deepEqual([renewal.plan, renewal.amount_cents], ["solo", 19000], "plano menor vai pelo preço de tabela");
  await pay(s, renewal.charge_id!);
  assert.deepEqual([(await agency(s.agencyId)).plan, (await agency(s.agencyId)).custom_price_cents], ["solo", null]);

  const t = await setup({ trialEnds: "2026-10-01T00:00:00Z" });
  await sql.query(`update agencies set custom_price_cents = 100000 where id = $1`, [t.agencyId]);
  await subscribe(t.deps, t.agencyId, t.owner, { plan: "escala" }, new Date("2026-11-01T12:00:00Z"));
  assert.equal((await invoices(t.agencyId))[0].amount_cents, 99000);
  assert.equal((await agency(t.agencyId)).custom_price_cents, null);
});

test("cancelamento no Asaas que falha fica na fila; cobrança criada para fatura já cancelada é desfeita; paga depois de cancelada vira crédito", async () => {
  const s = await setup();
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z"));
  const [first] = await invoices(s.agencyId);
  s.fake.hooks.failCancel = 1;
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "escala" }, new Date("2026-11-02T12:00:00Z"));
  assert.ok(await one(sql, `select 1 from spherum_charge_cancels where charge_id = $1`, [first.charge_id]));
  const r = await subscriptionSweep(s.deps, new Date("2026-11-03T12:00:00Z"));
  assert.equal(r.canceled, 1);
  assert.ok(s.fake.canceled.includes(first.charge_id!));
  assert.equal(await one(sql, `select 1 from spherum_charge_cancels where charge_id = $1`, [first.charge_id]), null);

  // Paga mesmo assim: não reativa nada, não quebra o índice único e o aviso responde normalmente.
  const before = await agency(s.agencyId);
  const res = await pay(s, first.charge_id!);
  assert.equal((res as { ok?: boolean }).ok, true);
  const again = (await invoices(s.agencyId)).find((i) => i.id === first.id)!;
  assert.equal(again.status, "cancelado");
  assert.match(again.error!, /crédito/);
  assert.deepEqual(await agency(s.agencyId), before);
  assert.ok(await one(sql, `select 1 from audit_events where action = 'assinatura_paga_cancelada' and agency_id = $1`, [s.agencyId]), "o admin vê na auditoria");

  const t = await setup();
  t.fake.hooks.onCreate = async (invoiceId) => { await sql.query(`update spherum_invoices set status = 'cancelado' where id = $1`, [invoiceId]); };
  await subscribe(t.deps, t.agencyId, t.owner, { plan: "agencia" }, new Date("2026-11-01T12:00:00Z"));
  const [inv] = await invoices(t.agencyId);
  assert.deepEqual([inv.status, inv.charge_id], ["cancelado", null]);
  assert.equal(t.fake.canceled.length, 1, "a cobrança recém-criada foi cancelada");
});

test("troca depois da renovação emitida refaz a fatura; pagar não desfaz o upgrade", async () => {
  const s = await paying();
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  await setAddon(s.deps, s.agencyId, s.owner, { addon: "xodo", qty: 1 }, new Date("2026-12-07T12:00:00Z"));
  let open = (await invoices(s.agencyId)).filter((i) => i.kind === "periodo" && i.status === "pendente");
  assert.deepEqual(open.map((i) => [i.period_start, i.amount_cents]), [["2026-12-10", 49000 + 14900]]);
  await subscribe(s.deps, s.agencyId, s.owner, { plan: "escala" }, new Date("2026-12-07T13:00:00Z"));
  open = (await invoices(s.agencyId)).filter((i) => i.kind === "periodo" && i.status === "pendente");
  assert.deepEqual(open.map((i) => [i.plan, i.amount_cents]), [["escala", 99000 + 14900]]);
  await pay(s, open[0].charge_id!);
  assert.equal((await agency(s.agencyId)).plan, "escala");
  const canceled = (await invoices(s.agencyId)).filter((i) => i.status === "cancelado");
  assert.equal(canceled.length, 2);
  assert.ok(canceled.every((i) => s.fake.canceled.includes(i.charge_id!)));
});

test("ajuste vencido também deixa em atraso e bloqueia; pagar libera", async () => {
  const s = await paying();
  const r = await setAddon(s.deps, s.agencyId, s.owner, { addon: "xodo", qty: 1 }, new Date("2026-11-20T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-11-24T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).plan_status, "past_due");
  await subscriptionSweep(s.deps, new Date("2026-12-02T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).locked_reason, "atraso");
  await pay(s, r.invoice!.charge_id!);
  const a = await agency(s.agencyId);
  assert.deepEqual([a.plan_status, a.locked_reason], ["active", null]);
});

test("clique duplo em add-on e upgrade gera um ajuste só", async () => {
  const s = await paying();
  const now = new Date("2026-11-25T12:00:00Z");
  await Promise.all([setAddon(s.deps, s.agencyId, s.owner, { addon: "xodo", qty: 1 }, now), setAddon(s.deps, s.agencyId, s.owner, { addon: "xodo", qty: 1 }, now)]);
  await Promise.all([subscribe(s.deps, s.agencyId, s.owner, { plan: "escala" }, now), subscribe(s.deps, s.agencyId, s.owner, { plan: "escala" }, now)]);
  assert.equal((await invoices(s.agencyId)).filter((i) => i.kind === "ajuste").length, 2, "um do add-on e um do upgrade");
});

test("estorno tira o período: em atraso e bloqueio depois da carência", async () => {
  const s = await paying();
  const [paid] = await invoices(s.agencyId);
  await subscriptionSweep(s.deps, new Date("2026-11-20T12:00:00Z"));
  await adminInvoiceAction(s.deps, s.owner, paid.id, { action: "refund", reason: "Chargeback do cartão" });
  const a = await agency(s.agencyId);
  assert.equal(a.current_period_end, "2026-11-10");
  await subscriptionSweep(s.deps, new Date("2026-11-21T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).plan_status, "past_due");
  assert.ok((await invoices(s.agencyId)).some((i) => i.period_start === "2026-11-10" && i.status === "pendente"), "nova fatura do período para pagar");
  await subscriptionSweep(s.deps, new Date("2026-11-22T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).locked_reason, "atraso");
});

test("vencida não volta a pendente quando o Asaas diz PENDING", async () => {
  const s = await paying();
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-11T12:00:00Z"));
  const renewal = (await invoices(s.agencyId))[1];
  assert.equal(renewal.status, "vencido");
  const notes = async () => (await one<{ n: number }>(sql, `select count(*)::int as n from notifications where agency_id = $1 and kind = 'assinatura_atraso'`, [s.agencyId]))!.n;
  const n = await notes();
  await hook(s, renewal.charge_id!);
  await subscriptionSweep(s.deps, new Date("2026-12-12T12:00:00Z"));
  assert.equal((await invoices(s.agencyId))[1].status, "vencido");
  assert.equal(await notes(), n, "sem aviso repetido");
});

test("admin: pagante à mão sai do bloqueio e das renovações; estender o teste desbloqueia", async () => {
  const s = await paying();
  await subscriptionSweep(s.deps, new Date("2026-12-06T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-11T12:00:00Z"));
  await subscriptionSweep(s.deps, new Date("2026-12-18T12:00:00Z"));
  assert.equal((await agency(s.agencyId)).locked_reason, "atraso");
  const staff = { id: s.owner, role: "dono" };
  await updateAgencyAdmin(sql, staff, s.agencyId, { plan_status: "active" });
  let a = await agency(s.agencyId);
  assert.deepEqual([a.plan_status, a.locked_reason, a.current_period_end], ["active", null, null]);
  const count = (await invoices(s.agencyId)).length;
  await subscriptionSweep(s.deps, new Date("2027-02-01T12:00:00Z"));
  a = await agency(s.agencyId);
  assert.deepEqual([a.plan_status, a.locked_reason, (await invoices(s.agencyId)).length], ["active", null, count]);

  const t = await setup({ trialEnds: "2026-11-10T15:00:00Z" });
  await subscriptionSweep(t.deps, new Date("2026-11-10T16:00:00Z"));
  assert.equal((await agency(t.agencyId)).locked_reason, "teste");
  await updateAgencyAdmin(sql, { id: t.owner, role: "dono" }, t.agencyId, { trial_days: 7 }, new Date("2026-11-11T12:00:00Z"));
  assert.equal((await agency(t.agencyId)).locked_reason, null);
});
