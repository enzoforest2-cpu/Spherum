import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { before, test } from "node:test";
import { createClient } from "../src/lib/core/clients";
import { createDeal, winDeal } from "../src/lib/core/crm";
import {
  apiAuth, apiClientMetrics, apiCreateDeal, apiCreateLeads, apiGetClient, apiListClients, apiListDeals, apiListLeads, apiListReports,
  API_RATE_PER_MIN, ApiError, createApiKey, listApiKeys, revokeApiKey,
} from "../src/lib/core/public-api";
import { createReport, setReportStatus } from "../src/lib/core/reports";
import { apiEnabled } from "../src/lib/core/subscription";
import { createWebhook, emitEvent, RETRY_DELAYS_MIN, testWebhook, WEBHOOK_LIMITS, webhookSweep } from "../src/lib/core/webhooks";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb, seedAgency, seedClient, seedMetrics } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const publicDns = async () => [{ address: "93.184.216.34" }];
const opts = { masterKey: MASTER, resolve: publicDns };

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function agency(plan: string, status = "active", name = "Agência API") {
  const a = await seedAgency(sql, name);
  await sql.query(`update agencies set plan = $2, plan_status = $3 where id = $1`, [a.agencyId, plan, status]);
  return a;
}

const req = (key: string | null, path = "/api/v1/clients") =>
  new Request(`https://app.spherum.com.br${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
}

type Sent = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(statusCode: number | (() => number)) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const code = typeof statusCode === "function" ? statusCode() : statusCode;
    return new Response(code === 204 ? null : "ok", { status: code });
  }) as unknown as typeof fetch;
  return { f, sent };
}

test("chave: só no Rede/Empresarial ou com o add-on; aparece inteira uma vez e o banco guarda só o hash", async () => {
  const trial = await agency("rede", "trial");
  assert.equal(await apiEnabled(sql, trial.agencyId), false, "no teste vale o Agência");
  await assert.rejects(createApiKey(sql, trial.agencyId, trial.ownerId, { name: "Zapier" }), (e: ApiError) => e.status === 402);

  const escala = await agency("escala");
  await assert.rejects(createApiKey(sql, escala.agencyId, escala.ownerId, { name: "Zapier" }), /plano Rede/);
  await sql.query(`insert into agency_addons (agency_id, addon_id, qty) values ($1, 'api', 1)`, [escala.agencyId]);
  assert.equal(await apiEnabled(sql, escala.agencyId), true, "Escala com o add-on");

  const solo = await agency("solo");
  await sql.query(`insert into agency_addons (agency_id, addon_id, qty) values ($1, 'api', 1)`, [solo.agencyId]);
  assert.equal(await apiEnabled(sql, solo.agencyId), false, "add-on não vale abaixo do Escala");

  for (const plan of ["rede", "empresarial"]) {
    const a = await agency(plan);
    const k = await createApiKey(sql, a.agencyId, a.ownerId, { name: "BI" });
    assert.match(k.key, /^sph_live_[A-Za-z0-9_-]{32}$/);
    assert.equal(k.prefix, k.key.slice(0, 13));
    assert.deepEqual(k.scopes, ["read"]);
    const [listed] = await listApiKeys(sql, a.agencyId);
    assert.equal(JSON.stringify(listed).includes(k.key), false, "a lista nunca mostra a chave");
    const row = await one<{ key_hash: string }>(sql, `select key_hash from api_keys where id = $1`, [k.id]);
    assert.notEqual(row!.key_hash, k.key);
    assert.equal(row!.key_hash.length, 64);
  }
});

test("autenticação: chave errada, revogada ou de quem saiu é recusada; escopo de leitura não escreve; bloqueada só lê; suspensa nada", async () => {
  const a = await agency("rede");
  const read = await createApiKey(sql, a.agencyId, a.ownerId, { name: "Leitura" });
  const write = await createApiKey(sql, a.agencyId, a.ownerId, { name: "Escrita", scopes: ["write"] });
  assert.deepEqual(write.scopes, ["read", "write"]);

  assert.equal(await status(apiAuth(sql, req(null), "read")), 401);
  assert.equal(await status(apiAuth(sql, req("sph_live_naoexiste"), "read")), 401);
  assert.equal(await status(apiAuth(sql, req(read.key.slice(0, -1) + (read.key.endsWith("x") ? "y" : "x")), "read")), 401);

  const ctx = await apiAuth(sql, req(read.key), "read");
  assert.equal(ctx.agencyId, a.agencyId);
  const used = await one<{ last_used_at: string | null }>(sql, `select last_used_at::text from api_keys where id = $1`, [read.id]);
  assert.ok(used!.last_used_at, "marca o último uso");

  await assert.rejects(apiAuth(sql, req(read.key), "write"), (e: ApiError) => e.status === 403 && /só lê/.test(e.message));
  assert.equal(await status(apiAuth(sql, req(write.key), "write")), 200);

  // Bloqueada pela cobrança: lê, não escreve.
  await sql.query(`update agencies set locked_at = now(), locked_reason = 'atraso' where id = $1`, [a.agencyId]);
  assert.equal(await status(apiAuth(sql, req(write.key), "read")), 200);
  assert.equal(await status(apiAuth(sql, req(write.key), "write")), 402);
  await sql.query(`update agencies set locked_at = null, locked_reason = null, suspended_at = now() where id = $1`, [a.agencyId]);
  assert.equal(await status(apiAuth(sql, req(read.key), "read")), 403);
  await sql.query(`update agencies set suspended_at = null where id = $1`, [a.agencyId]);

  // Desceu de plano: a chave para.
  await sql.query(`update agencies set plan = 'escala' where id = $1`, [a.agencyId]);
  assert.equal(await status(apiAuth(sql, req(read.key), "read")), 402);
  await sql.query(`update agencies set plan = 'rede' where id = $1`, [a.agencyId]);

  await revokeApiKey(sql, a.agencyId, a.ownerId, read.id);
  await assert.rejects(apiAuth(sql, req(read.key), "read"), /inválida ou revogada/);

  // Quem criou a chave saiu da agência.
  const other = (await one<{ id: string }>(sql, `select gen_random_uuid() as id`))!.id;
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'admin')`, [a.agencyId, other]);
  const hers = await createApiKey(sql, a.agencyId, other, { name: "Dela" });
  assert.equal(await status(apiAuth(sql, req(hers.key), "read")), 200);
  await sql.query(`delete from agency_members where agency_id = $1 and user_id = $2`, [a.agencyId, other]);
  assert.equal(await status(apiAuth(sql, req(hers.key), "read")), 401);
});

test("isolamento entre agências e paginação por cursor", async () => {
  const a = await agency("rede", "active", "Agência A");
  const b = await agency("rede", "active", "Agência B");
  const ka = await createApiKey(sql, a.agencyId, a.ownerId, { name: "A" });
  const kb = await createApiKey(sql, b.agencyId, b.ownerId, { name: "B" });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await seedClient(sql, a.agencyId, `Cliente ${i}`));
  await seedClient(sql, b.agencyId, "Cliente da B");
  const ca = await apiAuth(sql, req(ka.key), "read");
  const cb = await apiAuth(sql, req(kb.key), "read");

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const params: URLSearchParams = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
    const page = await apiListClients(sql, ca, params);
    pages++;
    assert.ok(page.data.length <= 2);
    seen.push(...page.data.map((c) => String(c.id)));
    assert.equal(page.has_more, !!page.next_cursor);
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual([...seen].sort(), [...ids].sort(), "todos, sem repetir");
  const first = (await apiListClients(sql, ca, new URLSearchParams())).data[0] as Record<string, unknown>;
  assert.ok("monthly_fee_cents" in first && "primary_contact" in first && !("_at" in first), "campos estáveis da API");

  await assert.rejects(apiListClients(sql, ca, new URLSearchParams({ cursor: "lixo" })), /Cursor inválido/);
  await assert.rejects(apiListClients(sql, ca, new URLSearchParams({ limit: "101" })), Error);

  // B não vê nada da A.
  assert.deepEqual((await apiListClients(sql, cb, new URLSearchParams())).data.map((c) => c.name), ["Cliente da B"]);
  await assert.rejects(apiGetClient(sql, cb, ids[0]), (e: ApiError) => e.status === 404);
  await assert.rejects(apiClientMetrics(sql, cb, ids[0], new URLSearchParams()), (e: ApiError) => e.status === 404);
  assert.equal((await apiGetClient(sql, ca, ids[0])).name, "Cliente 0");

  // Métricas: soma por dia e plataforma, só do intervalo.
  await seedMetrics(sql, a.agencyId, ids[0], [
    { day: "2026-10-01", spend_cents: 1000, clicks: 10, campaign_id: "c1" },
    { day: "2026-10-01", spend_cents: 500, clicks: 5, campaign_id: "c2" },
    { day: "2026-10-02", spend_cents: 700, leads: 2 },
    { day: "2026-09-30", spend_cents: 9999 },
  ]);
  const m = await apiClientMetrics(sql, ca, ids[0], new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" }));
  assert.deepEqual(m.data.map((r) => [r.date, r.platform, r.spend_cents, r.clicks]), [["2026-10-01", "meta", 1500, 15], ["2026-10-02", "meta", 700, 0]]);
  await assert.rejects(apiClientMetrics(sql, ca, ids[0], new URLSearchParams({ from: "2025-01-01", to: "2026-10-31" })), /366 dias/);

  // Negócios e relatórios publicados, também isolados.
  const kw = await createApiKey(sql, a.agencyId, a.ownerId, { name: "W", scopes: ["read", "write"] });
  const cw = await apiAuth(sql, req(kw.key), "write");
  const deal = await apiCreateDeal(sql, cw, { company: "Padaria Pão", value_cents: 250000, email: "dono@padaria.com" });
  assert.equal(deal.value_cents, 250000);
  assert.equal(deal.source, "api");
  assert.equal(deal.owner_user_id, null);
  await assert.rejects(apiCreateDeal(sql, cw, { company: "X", stage: "ganho" }), Error, "ganho só pelo app");
  assert.equal((await apiListDeals(sql, ca, new URLSearchParams())).data.length, 1);
  assert.equal((await apiListDeals(sql, cb, new URLSearchParams())).data.length, 0);
  const draft = await createReport(sql, a.agencyId, a.ownerId, { client_id: ids[0], title: "Rascunho", period_start: "2026-10-01", period_end: "2026-10-31" });
  await createReport(sql, a.agencyId, a.ownerId, { client_id: ids[1], title: "Outubro", period_start: "2026-10-01", period_end: "2026-10-31", publish: true });
  const reports = await apiListReports(sql, ca, new URLSearchParams());
  assert.deepEqual(reports.data.map((r) => r.title), ["Outubro"], "rascunho não sai");
  await setReportStatus(sql, a.agencyId, a.ownerId, draft.id, "published");
  assert.equal((await apiListReports(sql, ca, new URLSearchParams({ client_id: ids[0] }))).data.length, 1);
  assert.equal((await apiListReports(sql, cb, new URLSearchParams())).data.length, 0);
});

test("limite de taxa: 120 por minuto por chave, com Retry-After; no minuto seguinte libera", async () => {
  const a = await agency("rede");
  const k = await createApiKey(sql, a.agencyId, a.ownerId, { name: "Taxa" });
  const other = await createApiKey(sql, a.agencyId, a.ownerId, { name: "Outra" });
  const now = new Date("2026-10-30T15:00:10Z");
  for (let i = 0; i < API_RATE_PER_MIN; i++) await apiAuth(sql, req(k.key), "read", now);
  await assert.rejects(apiAuth(sql, req(k.key), "read", now), (e: ApiError) => e.status === 429 && e.headers["retry-after"] === "50");
  assert.equal(await status(apiAuth(sql, req(other.key), "read", now)), 200, "cada chave tem o seu limite");
  assert.equal(await status(apiAuth(sql, req(k.key), "read", new Date("2026-10-30T15:01:00Z"))), 200);
  const hits = await one<{ n: number }>(sql, `select count(*)::int as n from api_key_hits where key_id = $1`, [k.id]);
  assert.equal(hits!.n, 2, "um registro por minuto");
});

test("leads pela API: respeitam a lista de bloqueio, repetidos e inválidos; pedem consentimento", async () => {
  const a = await agency("rede");
  const k = await createApiKey(sql, a.agencyId, a.ownerId, { name: "Form", scopes: ["write"] });
  const ctx = await apiAuth(sql, req(k.key), "write");
  await sql.query(`insert into prospect_optouts (agency_id, phone) values ($1, '5541999990010')`, [a.agencyId]);
  await assert.rejects(apiCreateLeads(sql, ctx, { list: "Site", leads: [{ phone: "41999990011" }] }), /consent/);
  const r = await apiCreateLeads(sql, ctx, {
    list: "Site", consent: true,
    leads: [{ phone: "(41) 99999-0010", name: "Saiu" }, { phone: "41999990011", name: "Ana", company: "Studio Ana" }, { phone: "123" }, { phone: "41999990011" }],
  });
  assert.deepEqual(r, { added: 1, invalid: 1, duplicates: 1, blocked: 1 });
  const leads = await apiListLeads(sql, ctx, new URLSearchParams({ list: "Site" }));
  assert.deepEqual(leads.data.map((l) => [l.phone, l.name, l.source, l.list]), [["5541999990011", "Ana", "manual", "Site"]]);
  await assert.rejects(apiCreateLeads(sql, ctx, { list: "Site", consent: true, leads: Array.from({ length: 101 }, () => ({ phone: "41999990012" })) }), Error);
});

test("webhook: cadastro só https público; evento ao criar cliente sai assinado com HMAC", async () => {
  const a = await agency("rede");
  await assert.rejects(createWebhook(sql, a.agencyId, a.ownerId, { url: "http://hooks.exemplo.com/x", events: ["client.created"] }, opts), /https/);
  await assert.rejects(createWebhook(sql, a.agencyId, a.ownerId, { url: "https://10.0.0.5/x", events: ["client.created"] }, opts), /privada/);
  await assert.rejects(createWebhook(sql, a.agencyId, a.ownerId, { url: "https://hooks.exemplo.com/x", events: ["outra.coisa"] }, opts), Error);
  const solo = await agency("solo");
  await assert.rejects(createWebhook(sql, solo.agencyId, solo.ownerId, { url: "https://hooks.exemplo.com/x", events: ["client.created"] }, opts), /plano Rede/);

  const { endpoint, secret } = await createWebhook(sql, a.agencyId, a.ownerId, { url: "https://hooks.exemplo.com/spherum", events: ["client.created", "deal.won"] }, opts);
  assert.match(secret, /^whsec_/);
  assert.equal(endpoint.secret_hint, secret.slice(-4));
  const stored = await one<{ secret_ciphertext: string }>(sql, `select secret_ciphertext from webhook_endpoints where id = $1`, [endpoint.id]);
  assert.equal(stored!.secret_ciphertext.includes(secret), false, "segredo cifrado");

  const client = await createClient(sql, a.agencyId, a.ownerId, { name: "Loja Nova", monthly_fee: 1500 });
  // A fila usa o relógio do banco ao entrar; o agendador roda "um minuto depois".
  const now = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000);
  const { f, sent } = fakeFetch(200);
  const out = await webhookSweep(sql, f, now, opts);
  assert.equal(out.delivered, 1);
  assert.equal(sent.length, 1);
  const s = sent[0];
  assert.equal(s.url, "https://hooks.exemplo.com/spherum");
  assert.equal(s.headers["x-spherum-event"], "client.created");
  const [, t, v1] = s.headers["x-spherum-signature"].match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
  assert.equal(Number(t), Math.floor(now.getTime() / 1000));
  assert.equal(v1, createHmac("sha256", secret).update(`${t}.${s.body}`).digest("hex"), "HMAC-SHA256 sobre t.body");
  const body = JSON.parse(s.body);
  assert.equal(body.type, "client.created");
  assert.equal(body.agency_id, a.agencyId);
  assert.deepEqual([body.data.id, body.data.name, body.data.monthly_fee_cents], [client.id, "Loja Nova", 150000]);
  assert.equal((await webhookSweep(sql, f, now, opts)).delivered, 0, "entregue não sai de novo");

  // Teste manual pela tela: assinado do mesmo jeito.
  const t2 = fakeFetch(204);
  assert.deepEqual(await testWebhook(sql, a.agencyId, endpoint.id, t2.f, now, opts), { ok: true, status: 204, error: null });
  assert.equal(t2.sent[0].headers["x-spherum-event"], "webhook.test");

  // Evento não inscrito não entra na fila; agência sem endereço também não.
  await emitEvent(sql, a.agencyId, "lead.replied", { id: "x" });
  await emitEvent(sql, solo.agencyId, "client.created", { id: "x" });
  const n = await one<{ n: number }>(sql, `select count(*)::int as n from webhook_deliveries where event_type = 'lead.replied' or agency_id = $1`, [solo.agencyId]);
  assert.equal(n!.n, 0);
});

test("webhook: eventos nos pontos certos, dentro da transação, sem quebrar a ação principal", async () => {
  const a = await agency("rede");
  await createWebhook(sql, a.agencyId, a.ownerId, { url: "https://hooks.exemplo.com/todos", events: ["client.created", "deal.won", "report.published"] }, opts);
  const types = async () => (await sql.query<{ event_type: string }>(`select event_type from webhook_deliveries where agency_id = $1 order by created_at, event_type`, [a.agencyId])).map((r) => r.event_type);

  const deal = await createDeal(sql, a.agencyId, a.ownerId, { company: "Academia Fit", value: 2000 });
  await winDeal(sql, a.agencyId, a.ownerId, deal.id, { contract: false, onboarding: false });
  assert.deepEqual((await types()).sort(), ["client.created", "deal.won"], "negócio ganho cria o cliente e avisa os dois");
  const won = await one<{ body: string }>(sql, `select body from webhook_deliveries where agency_id = $1 and event_type = 'deal.won'`, [a.agencyId]);
  assert.equal(JSON.parse(won!.body).data.company, "Academia Fit");

  const clientId = await seedClient(sql, a.agencyId, "Cliente R");
  const rep = await createReport(sql, a.agencyId, a.ownerId, { client_id: clientId, title: "Set", period_start: "2026-09-01", period_end: "2026-09-30" });
  await setReportStatus(sql, a.agencyId, a.ownerId, rep.id, "published");
  await setReportStatus(sql, a.agencyId, a.ownerId, rep.id, "published");
  assert.equal((await types()).filter((t) => t === "report.published").length, 1, "publicar de novo não repete");

  // Ação desfeita: o evento some junto.
  await assert.rejects(sql.transaction(async (tx) => {
    await createClient(tx, a.agencyId, a.ownerId, { name: "Vai desfazer" });
    throw new Error("desfaz");
  }));
  assert.equal((await types()).filter((t) => t === "client.created").length, 1);

  // Erro dentro do emitEvent não estraga a transação de quem chamou.
  const ok = await sql.transaction(async (tx) => {
    await tx.query(`update agencies set name = 'Agência API' where id = $1`, [a.agencyId]);
    await emitEvent(tx, "não-é-uuid", "client.created", {});
    return (await one<{ n: number }>(tx, `select 1 as n`))!.n;
  });
  assert.equal(ok, 1);
  await emitEvent(sql, "não-é-uuid", "client.created", {});
});

test("webhook: nova tentativa com espera crescente, falha de vez e desativa o endereço depois de muitas falhas seguidas", async () => {
  // A fila é de todas as agências: tira o que os testes anteriores deixaram pendente.
  await sql.query(`update webhook_deliveries set status = 'cancelada' where status = 'pendente'`);
  const a = await agency("rede");
  const { endpoint } = await createWebhook(sql, a.agencyId, a.ownerId, { url: "https://hooks.exemplo.com/cai", events: ["client.created"] }, opts);
  await createClient(sql, a.agencyId, a.ownerId, { name: "Cliente Retry" });
  const { f, sent } = fakeFetch(500);
  let now = new Date(Date.now() + 60_000);
  const delivery = async () => (await one<{ status: string; attempts: number; next_at: string; last_status: number | null }>(sql,
    `select status, attempts, next_at::text, last_status from webhook_deliveries where endpoint_id = $1`, [endpoint.id]))!;

  for (let i = 0; i < RETRY_DELAYS_MIN.length; i++) {
    const r = await webhookSweep(sql, f, now, opts);
    assert.equal(r.retried, 1);
    const d = await delivery();
    assert.equal(d.status, "pendente");
    assert.equal(d.attempts, i + 1);
    assert.equal(d.last_status, 500);
    assert.equal(Date.parse(d.next_at), now.getTime() + RETRY_DELAYS_MIN[i] * 60_000);
    // Antes da hora, nada sai.
    assert.equal((await webhookSweep(sql, f, new Date(Date.parse(d.next_at) - 1000), opts)).retried, 0);
    now = new Date(Date.parse(d.next_at));
  }
  const total = RETRY_DELAYS_MIN.reduce((t, m) => t + m, 0);
  assert.ok(total >= 20 * 60 && total <= 26 * 60, "~24h somadas");
  assert.equal((await webhookSweep(sql, f, now, opts)).failed, 1);
  assert.equal((await delivery()).status, "falhou");
  assert.equal(sent.length, RETRY_DELAYS_MIN.length + 1);
  const ep = await one<{ failures: number; disabled_at: string | null }>(sql, `select failures, disabled_at from webhook_endpoints where id = $1`, [endpoint.id]);
  assert.deepEqual([ep!.failures, ep!.disabled_at], [RETRY_DELAYS_MIN.length + 1, null]);

  // Um sucesso zera as falhas seguidas.
  await createClient(sql, a.agencyId, a.ownerId, { name: "Cliente Ok" });
  await webhookSweep(sql, fakeFetch(200).f, now, opts);
  assert.equal((await one<{ failures: number }>(sql, `select failures from webhook_endpoints where id = $1`, [endpoint.id]))!.failures, 0);

  // Na beira do limite, mais uma falha desativa, cancela o que estava na fila e avisa a agência.
  await sql.query(`update webhook_endpoints set failures = $2 where id = $1`, [endpoint.id, WEBHOOK_LIMITS.disableAfter - 1]);
  await createClient(sql, a.agencyId, a.ownerId, { name: "Cliente 1" });
  await createClient(sql, a.agencyId, a.ownerId, { name: "Cliente 2" });
  const r = await webhookSweep(sql, f, now, opts);
  assert.equal(r.disabled, 1);
  const dis = await one<{ disabled_at: string | null; disabled_reason: string }>(sql, `select disabled_at::text, disabled_reason from webhook_endpoints where id = $1`, [endpoint.id]);
  assert.ok(dis!.disabled_at);
  assert.match(dis!.disabled_reason, /falhas seguidas/);
  const pend = await one<{ n: number }>(sql, `select count(*)::int as n from webhook_deliveries where endpoint_id = $1 and status = 'pendente'`, [endpoint.id]);
  assert.equal(pend!.n, 0);
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'webhook_desativado'`, [a.agencyId]));
  // Desativado não recebe mais eventos.
  await createClient(sql, a.agencyId, a.ownerId, { name: "Cliente 3" });
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from webhook_deliveries where endpoint_id = $1 and status = 'pendente'`, [endpoint.id]))!.n, 0);

  // Agência que desceu de plano: a fila não sai.
  const b = await agency("rede");
  await createWebhook(sql, b.agencyId, b.ownerId, { url: "https://hooks.exemplo.com/b", events: ["client.created"] }, opts);
  await createClient(sql, b.agencyId, b.ownerId, { name: "Cliente B" });
  await sql.query(`update agencies set plan = 'agencia' where id = $1`, [b.agencyId]);
  const nb = fakeFetch(200);
  assert.equal((await webhookSweep(sql, nb.f, now, opts)).canceled, 1);
  assert.equal(nb.sent.length, 0);
});
