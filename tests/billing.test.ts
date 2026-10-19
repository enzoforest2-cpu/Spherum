import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { billingSweep, connectAccount, createInvoice, handleWebhook, listClientInvoices, payInvoice, updateInvoice, type BillingDeps } from "../src/lib/billing";
import { itau, txidOf } from "../src/lib/billing/providers/itau";
import { createAgency } from "../src/lib/core/agencies";
import { addContact, createClient } from "../src/lib/core/clients";
import { inviteMember } from "../src/lib/core/team";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
type Call = { method: string; url: string; body: string; headers: Headers };

/** Provedor de mentira: cada rota responde o que o teste mandar. */
function fakeHttp(routes: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const c: Call = { method, url, body: typeof init?.body === "string" ? init.body : "", headers: new Headers(init?.headers) };
    calls.push(c);
    const key = Object.keys(routes).find((k) => {
      const [m, path] = k.split(" ");
      return m === method && url.includes(path);
    });
    if (!key) return new Response(JSON.stringify({ errors: [{ description: `sem rota ${method} ${url}` }] }), { status: 404 });
    const out = routes[key](c);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function user(email: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [email]))!.id;
}

async function setup() {
  const dona = await user(`dona-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Cobra" });
  const c = await createClient(sql, agencyId, dona, { name: "Cliente Pagador", cnpj: "12.345.678/0001-90" });
  await addContact(sql, agencyId, c.id, { name: "Rui", email: "rui@cliente.com", phone: "11999990000", is_primary: true });
  const semDoc = await createClient(sql, agencyId, dona, { name: "Sem Documento" });
  const cli = await user(`cli-${randomUUID()}@x.com`);
  await sql.query(`insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3)`, [c.id, agencyId, cli]);
  return { dona, agencyId, client: c, semDoc, cli };
}

test("Asaas: conecta com aviso cadastrado, cobra com Pix e boleto, aviso confirma o pagamento com o próprio Asaas", async () => {
  const s = await setup();
  let paymentStatus = "PENDING";
  const http = fakeHttp({
    "GET /v3/myAccount": () => ({ company: "Agência Cobra LTDA" }),
    "POST /v3/webhooks": () => ({ id: "wh_1" }),
    "POST /v3/customers": () => ({ id: "cus_1" }),
    "POST /v3/payments": (c) => ({ id: `pay_${JSON.parse(c.body).dueDate}`, status: "PENDING", invoiceUrl: "https://www.asaas.com/i/abc", bankSlipUrl: "https://www.asaas.com/b/abc", value: 1500 }),
    "GET /pixQrCode": () => ({ payload: "00020126pix" }),
    "GET /identificationField": () => ({ identificationField: "23793.38128 60082" }),
    "GET /v3/payments/pay_": () => ({ id: "pay_x", status: paymentStatus, value: 1500, billingType: "PIX", clientPaymentDate: "2026-10-20" }),
    "DELETE /v3/payments/": () => ({ deleted: true }),
  });
  const deps: BillingDeps = { sql, masterKey: MASTER, fetch: http.fetch, appUrl: "https://spherum.com.br" };

  await assert.rejects(connectAccount(deps, s.agencyId, s.dona, { provider: "asaas", credentials: { api_key: "errada" } }), /não parece uma chave/);
  const { account, warning } = await connectAccount(deps, s.agencyId, s.dona, { provider: "asaas", environment: "teste", credentials: { api_key: "$aact_abc123" } });
  assert.equal(warning, null);
  assert.deepEqual([account.label, account.is_default, account.key_last4, account.environment], ["Agência Cobra LTDA", true, "c123", "teste"]);
  assert.ok(http.calls.every((c) => c.url.startsWith("https://api-sandbox.asaas.com/v3")), "teste usa o sandbox");
  const hook = JSON.parse(http.calls.find((c) => c.url.endsWith("/webhooks"))!.body);
  const stored = await one<{ webhook_token: string; ciphertext: string }>(sql, `select webhook_token, ciphertext from payment_accounts where id = $1`, [account.id]);
  assert.equal(hook.authToken, stored!.webhook_token);
  assert.equal(hook.url, `https://spherum.com.br/api/billing/webhooks/asaas/${stored!.webhook_token}`);
  assert.doesNotMatch(stored!.ciphertext, /aact/, "chave cifrada");

  // Sem CPF/CNPJ: a fatura fica, com o aviso do erro.
  const noDoc = await createInvoice(deps, s.agencyId, s.dona, { client_id: s.semDoc.id, description: "Mensalidade", amount: 1500, due_date: "2026-11-05" });
  assert.match(noDoc.warning!, /CPF ou CNPJ/);
  assert.equal(noDoc.invoice.status, "pendente");

  const { invoice, warning: w2 } = await createInvoice(deps, s.agencyId, s.dona, { client_id: s.client.id, description: "Mensalidade nov/26", amount: 1500, due_date: "2026-11-05" });
  assert.equal(w2, null);
  assert.deepEqual([invoice.provider, invoice.payment_url, invoice.pix_code, invoice.boleto_line, invoice.amount_cents], ["asaas", "https://www.asaas.com/i/abc", "00020126pix", "23793.38128 60082", 150000]);
  const pay = JSON.parse(http.calls.find((c) => c.url.endsWith("/v3/payments") && c.method === "POST")!.body);
  assert.deepEqual([pay.customer, pay.billingType, pay.value, pay.externalReference], ["cus_1", "UNDEFINED", 1500, invoice.id]);
  // Segunda fatura reaproveita o cadastro do cliente no Asaas.
  await createInvoice(deps, s.agencyId, s.dona, { client_id: s.client.id, description: "Extra", amount: 200, due_date: "2026-11-06", methods: ["pix"] });
  assert.equal(http.calls.filter((c) => c.url.endsWith("/v3/customers")).length, 1);
  assert.equal(JSON.parse(http.calls.filter((c) => c.url.endsWith("/v3/payments")).pop()!.body).billingType, "PIX");

  // O cliente pega o link; quem não é do cliente nem da agência, não.
  const link = await payInvoice(deps, s.cli, invoice.id);
  assert.deepEqual([link.url, link.pix_code], ["https://www.asaas.com/i/abc", "00020126pix"]);
  await assert.rejects(payInvoice(deps, await user(`x-${randomUUID()}@x.com`), invoice.id), /não encontrada/);

  // Aviso: precisa do token no cabeçalho; o status vem do Asaas, não do corpo.
  const body = { id: "evt_1", event: "PAYMENT_RECEIVED", payment: { id: "pay_2026-11-05", status: "RECEIVED" } };
  await assert.rejects(handleWebhook(deps, "asaas", stored!.webhook_token, new Headers({ "asaas-access-token": "outro" }), body, new URLSearchParams()), /Não autorizado/);
  const h = new Headers({ "asaas-access-token": stored!.webhook_token });
  assert.deepEqual(await handleWebhook(deps, "asaas", stored!.webhook_token, h, body, new URLSearchParams()), { invoice_id: invoice.id, status: "pendente" }, "corpo diz pago, Asaas diz pendente");
  paymentStatus = "RECEIVED";
  await handleWebhook(deps, "asaas", stored!.webhook_token, h, { ...body, id: "evt_2" }, new URLSearchParams());
  assert.deepEqual(await handleWebhook(deps, "asaas", stored!.webhook_token, h, { ...body, id: "evt_2" }, new URLSearchParams()), { duplicate: true });
  const paid = (await listClientInvoices(sql, s.client.id)).find((i) => i.id === invoice.id)!;
  assert.deepEqual([paid.status, paid.paid_cents, paid.paid_method], ["pago", 150000, "pix"]);
  await assert.rejects(payInvoice(deps, s.cli, invoice.id), /já está paga/);
  await assert.rejects(handleWebhook(deps, "asaas", "token-que-nao-existe-0000000000000000", h, body, new URLSearchParams()), /Não encontrado/);

  // Cancelar apaga no Asaas; marcar como pago à mão.
  const other = (await listClientInvoices(sql, s.client.id)).find((i) => i.description === "Extra")!;
  await updateInvoice(deps, s.agencyId, s.dona, other.id, { action: "cancelar" });
  assert.ok(http.calls.some((c) => c.method === "DELETE" && c.url.includes("/v3/payments/")));
  assert.equal((await listClientInvoices(sql, s.client.id)).some((i) => i.id === other.id), false, "cliente não vê cancelada");
  const manual = await updateInvoice(deps, s.agencyId, s.dona, noDoc.invoice.id, { action: "marcar_pago" });
  assert.deepEqual([manual.invoice.status, manual.invoice.paid_manually], ["pago", true]);
});

test("Mercado Pago e Stripe: link de pagamento e aviso confirmado no provedor", async () => {
  const s = await setup();
  let mpStatus = "pending";
  let invoiceForMp = "";
  const http = fakeHttp({
    "GET api.mercadopago.com/users/me": () => ({ nickname: "AGENCIA" }),
    "POST /checkout/preferences": () => ({ id: "pref_1", init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref_1" }),
    "GET /v1/payments/search": () => ({ results: [{ id: 9, status: mpStatus, external_reference: invoiceForMp, transaction_amount: 300, payment_type_id: "bank_transfer", date_approved: "2026-10-21T10:00:00Z" }] }),
    "GET /v1/payments/9": () => ({ id: 9, status: mpStatus, external_reference: invoiceForMp, transaction_amount: 300, payment_type_id: "bank_transfer" }),
    "GET api.stripe.com/v1/account": () => ({ business_profile: { name: "Agência no Stripe" } }),
    "POST /v1/webhook_endpoints": () => ({ id: "we_1" }),
    "POST /v1/checkout/sessions": () => ({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }),
    "GET /v1/payment_intents/search": () => ({ data: [{ id: "pi_1", status: "succeeded", amount_received: 50000, created: 1792000000, latest_charge: { refunded: false, payment_method_details: { type: "card" } } }] }),
  });
  const deps: BillingDeps = { sql, masterKey: MASTER, fetch: http.fetch, appUrl: "https://spherum.com.br" };

  const mp = await connectAccount(deps, s.agencyId, s.dona, { provider: "mercadopago", credentials: { access_token: "APP_USR-123" } });
  const { invoice } = await createInvoice(deps, s.agencyId, s.dona, { client_id: s.client.id, description: "Criativos", amount: 300, due_date: "2026-11-10", methods: ["pix", "cartao"] });
  invoiceForMp = invoice.id;
  const pref = JSON.parse(http.calls.find((c) => c.url.endsWith("/checkout/preferences"))!.body);
  const mpToken = (await one<{ webhook_token: string }>(sql, `select webhook_token from payment_accounts where id = $1`, [mp.account.id]))!.webhook_token;
  assert.equal(pref.external_reference, invoice.id);
  assert.equal(pref.notification_url, `https://spherum.com.br/api/billing/webhooks/mercadopago/${mpToken}`);
  assert.deepEqual(pref.payment_methods.excluded_payment_types, [{ id: "ticket" }]);
  assert.match(invoice.payment_url!, /pref_id=pref_1/);
  await handleWebhook(deps, "mercadopago", mpToken, new Headers(), { id: 1, type: "payment", action: "payment.created", data: { id: "9" } }, new URLSearchParams());
  assert.equal((await listClientInvoices(sql, s.client.id))[0].status, "pendente");
  mpStatus = "approved";
  await handleWebhook(deps, "mercadopago", mpToken, new Headers(), { id: 2, type: "payment", action: "payment.updated", data: { id: "9" } }, new URLSearchParams());
  const mpPaid = (await listClientInvoices(sql, s.client.id))[0];
  assert.deepEqual([mpPaid.status, mpPaid.paid_cents, mpPaid.paid_method], ["pago", 30000, "pix"]);

  // Stripe vira a conta padrão quando a agência escolhe; o link nasce no clique.
  const st = await connectAccount(deps, s.agencyId, s.dona, { provider: "stripe", credentials: { secret_key: "sk_live_abc" } });
  assert.equal(st.account.is_default, false, "a primeira conta continua padrão");
  await sql.query(`update payment_accounts set is_default = (id = $1) where agency_id = $2`, [st.account.id, s.agencyId]);
  const { invoice: si } = await createInvoice(deps, s.agencyId, s.dona, { client_id: s.client.id, description: "Setup", amount: 500, due_date: "2026-11-12" });
  assert.equal(si.payment_url, null);
  const link = await payInvoice(deps, s.cli, si.id);
  assert.equal(link.url, "https://checkout.stripe.com/c/pay/cs_1");
  const session = new URLSearchParams(http.calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!.body);
  assert.deepEqual([session.get("metadata[invoice_id]"), session.get("line_items[0][price_data][unit_amount]"), session.get("line_items[0][price_data][currency]")], [si.id, "50000", "brl"]);
  const stToken = (await one<{ webhook_token: string }>(sql, `select webhook_token from payment_accounts where id = $1`, [st.account.id]))!.webhook_token;
  await handleWebhook(deps, "stripe", stToken, new Headers(), { id: "evt_s1", type: "checkout.session.completed", data: { object: { metadata: { invoice_id: si.id } } } }, new URLSearchParams());
  const sPaid = (await listClientInvoices(sql, s.client.id)).find((i) => i.id === si.id)!;
  assert.deepEqual([sPaid.status, sPaid.paid_method], ["pago", "cartao"]);
  // Aviso com fatura de outra agência não mexe em nada.
  const other = await setup();
  const { invoice: foreign } = await createInvoice(deps, other.agencyId, other.dona, { client_id: other.client.id, description: "X", amount: 10, due_date: "2026-11-12" });
  assert.deepEqual(await handleWebhook(deps, "stripe", stToken, new Headers(), { id: "evt_s2", type: "checkout.session.completed", data: { object: { metadata: { invoice_id: foreign.id } } } }, new URLSearchParams()), { ignored: true });
});

test("mensalidade: gera a próxima fatura antes do vencimento, uma vez só; vencidas viram vencido", async () => {
  const s = await setup();
  const http = fakeHttp({});
  let now = new Date("2026-10-19T12:00:00Z");
  const deps: BillingDeps = { sql, masterKey: MASTER, fetch: http.fetch, appUrl: "https://spherum.com.br", now: () => now };
  const { invoice } = await createInvoice(deps, s.agencyId, s.dona, { client_id: s.client.id, description: "Mensalidade", amount: 3000, due_date: "2026-10-15", monthly: true });
  assert.equal(invoice.payment_url, null, "sem conta de pagamento, só registra");
  const rec = await one<{ next_due: string; day_of_month: number }>(sql, `select next_due::text, day_of_month from invoice_recurrences where id = $1`, [invoice.recurrence_id]);
  assert.deepEqual([rec!.next_due, rec!.day_of_month], ["2026-11-15", 15]);

  const first = await billingSweep(deps);
  assert.ok(first.overdue >= 1);
  assert.equal(first.generated, 0, "novembro ainda está a mais de 10 dias");
  now = new Date("2026-11-06T12:00:00Z");
  assert.equal((await billingSweep(deps)).generated, 1);
  assert.equal((await billingSweep(deps)).generated, 0, "não repete");
  const list = await listClientInvoices(sql, s.client.id);
  assert.deepEqual(list.map((i) => [i.due_date, i.status]), [["2026-11-15", "pendente"], ["2026-10-15", "vencido"]]);
  // Pausada não gera.
  await sql.query(`update invoice_recurrences set active = false where id = $1`, [invoice.recurrence_id]);
  now = new Date("2026-12-10T12:00:00Z");
  assert.equal((await billingSweep(deps)).generated, 0);
});

test("papel financeiro na equipe e Itaú: campos obrigatórios e txid do Pix", async () => {
  const s = await setup();
  const inv = await inviteMember(sql, s.agencyId, { id: s.dona, role: "owner" }, { email: "fin@x.com", role: "financeiro" });
  assert.equal(inv.role, "financeiro");
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'financeiro')`, [s.agencyId, await user(`f-${randomUUID()}@x.com`)]);

  const t = txidOf("6a966aed-4854-4edf-b60f-b96d3c2478ca");
  assert.ok(/^[a-z0-9]{26,35}$/i.test(t), t);
  await assert.rejects(itau.verify({ creds: { client_id: "a" }, env: "producao", http: fetch }), /Preencha todos/);
  await assert.rejects(itau.verify({ creds: { client_id: "a", client_secret: "b", pix_key: "c", cert: "x", key: "y" }, env: "producao", http: fetch }), /PEM/);
});
