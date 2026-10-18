import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ga4Daily, listGa4Properties } from "../src/lib/integrations/ads/ga4";
import { googleAds } from "../src/lib/integrations/ads/google-ads";
import { metaAds } from "../src/lib/integrations/ads/meta";
import { linkAccount, syncAccount, syncDueAccounts, syncWindow, type AccountRow } from "../src/lib/integrations/ads/sync";
import { tiktokAds } from "../src/lib/integrations/ads/tiktok";
import { saveConnection, warnExpiringConnections, type IntegrationDeps } from "../src/lib/integrations/store";
import { decideAction } from "../src/lib/xodos/actions";
import { num, one, type Sql } from "../src/lib/xodos/db";
import { continueRun, startRun, toolsFor } from "../src/lib/xodos/runner";
import { Clock, createTestDb, FakeModel, seedAgency, seedClient, seedFx, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
  await seedFx(sql, "2026-10-01", 5);
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev-token";
});

type Call = { url: string; method: string; body: string; headers: Headers };
function fakeFetch(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? "GET", body: String(init.body ?? ""), headers: new Headers(init.headers) };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const pa = (http: typeof fetch, extra = {}) => ({ accessToken: "tok", http, ...extra });

// ---------------------------------------------------------------------------
// Formatos de cada plataforma
// ---------------------------------------------------------------------------

test("Meta: insights por campanha e dia, com leads, compras e receita, seguindo as páginas", async () => {
  const f = fakeFetch((c) =>
    c.url.includes("after=2")
      ? { data: [{ campaign_id: "c2", campaign_name: "Remarketing", date_start: "2026-10-01", spend: "10.5", impressions: "100", clicks: "5" }] }
      : {
          data: [
            {
              campaign_id: "c1",
              campaign_name: "Leads",
              date_start: "2026-10-01",
              spend: "123.45",
              impressions: "10000",
              clicks: "250",
              actions: [
                { action_type: "lead", value: "12" },
                { action_type: "onsite_conversion.lead_grouped", value: "12" },
                { action_type: "purchase", value: "3" },
                { action_type: "omni_purchase", value: "3" },
              ],
              action_values: [{ action_type: "purchase", value: "900.10" }],
            },
          ],
          paging: { next: "https://graph.facebook.com/v23.0/act_1/insights?after=2" },
        },
  );
  const rows = await metaAds.daily(pa(f.fn), { externalId: "1", metadata: {} }, "2026-10-01", "2026-10-01");
  assert.deepEqual(rows[0], {
    campaignId: "c1",
    campaignName: "Leads",
    day: "2026-10-01",
    spend: 123.45,
    impressions: 10000,
    clicks: 250,
    leads: 12,
    conversions: 3,
    revenue: 900.1,
  });
  assert.equal(rows.length, 2);
  assert.match(decodeURIComponent(f.calls[0].url), /act_1\/insights\?level=campaign&time_increment=1&time_range=\{"since":"2026-10-01","until":"2026-10-01"\}/);
  assert.equal(f.calls[0].headers.get("authorization"), "Bearer tok");
});

test("Google Ads: contas de uma MCC com login-customer-id e custo em micros", async () => {
  const f = fakeFetch((c) => {
    if (c.url.endsWith("customers:listAccessibleCustomers")) return { resourceNames: ["customers/111"] };
    const q = JSON.parse(c.body || "{}").query ?? "";
    if (q.includes("FROM customer LIMIT 1")) return { results: [{ customer: { id: "111", descriptiveName: "MCC Agência", manager: true } }] };
    if (q.includes("FROM customer_client")) {
      return {
        results: [
          { customerClient: { id: "222", descriptiveName: "Loja Verano", currencyCode: "BRL", manager: false } },
          { customerClient: { id: "333", descriptiveName: "Sub-MCC", manager: true } },
        ],
      };
    }
    if (q.includes("FROM campaign WHERE segments.date")) {
      return {
        results: [
          {
            campaign: { id: "9", name: "Pesquisa" },
            segments: { date: "2026-10-01" },
            metrics: { costMicros: "45670000", impressions: "1200", clicks: "80", conversions: 6.6, conversionsValue: 1500.5 },
          },
        ],
      };
    }
    return { results: [] };
  });
  // O SDK devolve customerClient em camelCase; o código lê customer_client e customerClient.
  const accounts = await googleAds.listAccounts(pa(f.fn));
  assert.deepEqual(accounts, [{ externalId: "222", name: "Loja Verano", currency: "BRL", metadata: { login_customer_id: "111" } }]);
  const childCall = f.calls.find((c) => c.body.includes("customer_client"))!;
  assert.equal(childCall.headers.get("login-customer-id"), "111");
  assert.equal(childCall.headers.get("developer-token"), "dev-token");

  const rows = await googleAds.daily(pa(f.fn), { externalId: "222", metadata: { login_customer_id: "111" } }, "2026-10-01", "2026-10-01");
  assert.deepEqual(rows[0], {
    campaignId: "9",
    campaignName: "Pesquisa",
    day: "2026-10-01",
    spend: 45.67,
    impressions: 1200,
    clicks: 80,
    leads: 0,
    conversions: 7,
    revenue: 1500.5,
  });
  await assert.rejects(googleAds.daily(pa(f.fn), { externalId: "222", metadata: {} }, "2026-10-01'; DROP", "2026-10-01"), /Data inválida/);
});

test("Google Ads: muda a verba pelo recurso de orçamento, em micros", async () => {
  const f = fakeFetch((c) => {
    if (c.url.endsWith("googleAds:search")) return { results: [{ campaign: { campaignBudget: "customers/222/campaignBudgets/77" } }] };
    return {};
  });
  await googleAds.setDailyBudget(pa(f.fn), { externalId: "222", metadata: {} }, "9", 150.25);
  const mutate = f.calls.find((c) => c.url.endsWith("campaignBudgets:mutate"))!;
  assert.deepEqual(JSON.parse(mutate.body), {
    operations: [{ update: { resourceName: "customers/222/campaignBudgets/77", amountMicros: "150250000" }, updateMask: "amount_micros" }],
  });
});

test("TikTok: anunciantes do login e relatório paginado", async () => {
  const f = fakeFetch((c) => {
    if (c.url.includes("/advertiser/info/")) return { code: 0, data: { list: [{ advertiser_id: "a1", name: "Loja TikTok", currency: "BRL" }] } };
    const page = new URL(c.url).searchParams.get("page");
    return {
      code: 0,
      data: {
        list: [
          {
            dimensions: { campaign_id: `c${page}`, stat_time_day: "2026-10-01 00:00:00" },
            metrics: { campaign_name: `Campanha ${page}`, spend: "20.10", impressions: "500", clicks: "9", conversion: "2" },
          },
        ],
        page_info: { total_page: 2 },
      },
    };
  });
  const accounts = await tiktokAds.listAccounts(pa(f.fn, { connectionMetadata: { advertiser_ids: ["a1"] } }));
  assert.deepEqual(accounts, [{ externalId: "a1", name: "Loja TikTok", currency: "BRL" }]);
  const rows = await tiktokAds.daily(pa(f.fn), { externalId: "a1", metadata: {} }, "2026-10-01", "2026-10-01");
  assert.deepEqual(rows.map((r) => [r.campaignId, r.day, r.spend, r.conversions]), [
    ["c1", "2026-10-01", 20.1, 2],
    ["c2", "2026-10-01", 20.1, 2],
  ]);
  assert.equal(f.calls.find((c) => c.url.includes("/report/"))!.headers.get("access-token"), "tok");
});

test("GA4: propriedades e relatório por dia e canal", async () => {
  const f = fakeFetch((c) =>
    c.url.includes("accountSummaries")
      ? { accountSummaries: [{ displayName: "Agência", propertySummaries: [{ property: "properties/123", displayName: "Site Verano" }] }] }
      : {
          rows: [
            { dimensionValues: [{ value: "20261001" }, { value: "Organic Search" }], metricValues: [{ value: "40" }, { value: "35" }, { value: "3" }, { value: "250.5" }] },
          ],
        },
  );
  assert.deepEqual(await listGa4Properties(pa(f.fn)), [{ externalId: "123", name: "Site Verano", account: "Agência" }]);
  assert.deepEqual(await ga4Daily(pa(f.fn), "123", "2026-10-01", "2026-10-01"), [
    { day: "2026-10-01", channel: "Organic Search", sessions: 40, users: 35, keyEvents: 3, revenue: 250.5 },
  ]);
});

// ---------------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------------

async function agencyWithMeta(fetchFn: typeof fetch, currency = "BRL") {
  const { agencyId, ownerId } = await seedAgency(sql);
  const clientId = await seedClient(sql, agencyId, "Loja Verano");
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: fetchFn, appUrl: "https://spherum.com.br", now: new Clock(new Date("2026-10-02T12:00:00Z")).now };
  const connectionId = await saveConnection(deps, {
    agencyId,
    provider: "meta",
    label: "Meta da agência",
    account: `meta-${agencyId}`,
    scopes: ["ads_read", "ads_management", "business_management"],
    secret: { accessToken: "meta-token" },
  });
  const accountId = await linkAccount(sql, { agencyId, clientId, platform: "meta", externalId: "act_1", name: "Verano", currency, connectionId });
  return { agencyId, ownerId, clientId, connectionId, accountId, deps };
}

const insights = () =>
  fakeFetch(() => ({
    data: [{ campaign_id: "c1", campaign_name: "Leads", date_start: "2026-10-01", spend: "100", impressions: "1000", clicks: "10", actions: [{ action_type: "lead", value: "4" }] }],
  }));

test("sincroniza para metrics_daily, atualiza em vez de duplicar e converte contas em dólar", async () => {
  const f = insights();
  const brl = await agencyWithMeta(f.fn);
  const row = (await one<AccountRow>(sql, `select * from client_ad_accounts where id = $1`, [brl.accountId]))!;
  assert.equal(await syncAccount(brl.deps, row, "2026-10-01", "2026-10-01"), 1);
  await syncAccount(brl.deps, row, "2026-10-01", "2026-10-01");
  const saved = await sql.query(`select spend_cents, leads from metrics_daily where client_id = $1`, [brl.clientId]);
  assert.deepEqual(saved.map((r) => [num(r.spend_cents), num(r.leads)]), [[10_000, 4]]);
  assert.ok((await one(sql, `select last_synced_at from client_ad_accounts where id = $1`, [brl.accountId]))!.last_synced_at);

  const usd = await agencyWithMeta(insights().fn, "USD");
  const usdRow = (await one<AccountRow>(sql, `select * from client_ad_accounts where id = $1`, [usd.accountId]))!;
  await syncAccount(usd.deps, usdRow, "2026-10-01", "2026-10-01");
  const converted = await one(sql, `select spend_cents from metrics_daily where client_id = $1`, [usd.clientId]);
  assert.equal(num(converted!.spend_cents), 50_000, "US$ 100 a R$ 5,00");
});

test("conta de cliente de outra agência é recusada; erro de sincronização fica registrado na conta", async () => {
  const f = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token" } }), { status: 400 }));
  const a = await agencyWithMeta(f.fn);
  const other = await seedAgency(sql, "Outra");
  const foreign = await seedClient(sql, other.agencyId, "Cliente da outra");
  await assert.rejects(
    linkAccount(sql, { agencyId: a.agencyId, clientId: foreign, platform: "meta", externalId: "act_9", connectionId: a.connectionId }),
    /não pertence/,
  );
  const row = (await one<AccountRow>(sql, `select * from client_ad_accounts where id = $1`, [a.accountId]))!;
  await assert.rejects(syncAccount(a.deps, row, "2026-10-01", "2026-10-01"), /Invalid OAuth/);
  assert.match((await one(sql, `select last_sync_error from client_ad_accounts where id = $1`, [a.accountId]))!.last_sync_error as string, /Invalid OAuth/);
});

test("janela de sincronização: 30 dias na primeira vez, 3 depois; o cron pega só as atrasadas", async () => {
  const now = new Date("2026-10-02T12:00:00Z");
  assert.deepEqual(syncWindow({ last_synced_at: null }, now), { since: "2026-09-03", until: "2026-10-02" });
  assert.deepEqual(syncWindow({ last_synced_at: now }, now), { since: "2026-09-30", until: "2026-10-02" });

  const { sql: db } = await createTestDb();
  const f = insights();
  const { agencyId } = await seedAgency(db);
  const clientId = await seedClient(db, agencyId, "C");
  const deps: IntegrationDeps = { sql: db, masterKey: MASTER, fetch: f.fn, appUrl: "https://x", now: () => now };
  const connectionId = await saveConnection(deps, { agencyId, provider: "meta", label: "M", account: "m", secret: { accessToken: "t" } });
  await linkAccount(db, { agencyId, clientId, platform: "meta", externalId: "act_1", connectionId });
  assert.equal((await syncDueAccounts(deps)).length, 1);
  assert.equal((await syncDueAccounts(deps)).length, 0, "acabou de sincronizar");
});

test("avisa uma vez quando o login da Meta está para vencer", async () => {
  const { sql: db } = await createTestDb();
  const now = new Date("2026-10-02T12:00:00Z");
  const deps: IntegrationDeps = { sql: db, masterKey: MASTER, fetch: fetch, appUrl: "https://x", now: () => now };
  const { agencyId } = await seedAgency(db);
  await saveConnection(deps, { agencyId, provider: "meta", label: "Meta", account: "m1", secret: { accessToken: "t" }, expiresAt: new Date(now.getTime() + 3 * 86_400_000) });
  await saveConnection(deps, { agencyId, provider: "meta", label: "Longe", account: "m2", secret: { accessToken: "t" }, expiresAt: new Date(now.getTime() + 40 * 86_400_000) });
  assert.equal(await warnExpiringConnections(deps), 1);
  assert.equal(await warnExpiringConnections(deps), 0);
  const [n] = await db.query<{ title: string }>(`select title from notifications where agency_id = $1`, [agencyId]);
  assert.match(n.title, /vence em 3 dias/);
});

// ---------------------------------------------------------------------------
// Ferramentas no xodó
// ---------------------------------------------------------------------------

function metaApi(budgetCents = "10000") {
  return fakeFetch((c) => {
    if (c.url.includes("/campaigns?")) {
      return { data: [{ id: "c1", name: "Leads", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: budgetCents }] };
    }
    if (c.url.includes("/c1?fields=daily_budget")) return { daily_budget: budgetCents };
    if (c.method === "POST") return { success: true };
    return { data: [] };
  });
}

async function xodoWithMeta(autonomy = "pergunta_no_que_importa", overrides: Record<string, unknown> = {}) {
  const f = metaApi();
  const ctx = await agencyWithMeta(f.fn);
  const xodo = await seedXodo(sql, ctx.agencyId, { autonomy, ...overrides });
  await sql.query(`insert into xodo_apps (xodo_id, agency_id, app) values ($1, $2, 'meta_ads')`, [xodo.id, ctx.agencyId]);
  return { ...ctx, xodo, f };
}

const engineFor = (model: FakeModel, fetchFn: typeof fetch) => ({
  ...testDeps(sql, model, new Clock(new Date("2026-10-02T12:00:00Z"))),
  integrations: { masterKey: MASTER, fetch: fetchFn, appUrl: "https://spherum.com.br" },
});

test("ferramentas de anúncio só aparecem com o app liberado ao xodó", async () => {
  const { xodo, agencyId, f } = await xodoWithMeta();
  const engine = engineFor(new FakeModel([]), f.fn);
  assert.ok((await toolsFor(engine, xodo)).some((t) => t.name === "pausar_campanha"));
  await sql.query(`delete from xodo_apps where xodo_id = $1`, [xodo.id]);
  assert.ok(!(await toolsFor(engine, xodo)).some((t) => t.name === "pausar_campanha"));
  // A leitura do GA4 sincronizado é interna e está sempre disponível.
  assert.ok((await toolsFor(engine, { ...xodo, agency_id: agencyId })).some((t) => t.name === "consultar_analytics"));
});

test("lista campanhas direto; pausar espera aprovação e vai para a Meta uma vez só", async () => {
  const { xodo, agencyId, ownerId, clientId, f } = await xodoWithMeta();
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "listar_campanhas", input: { client_id: clientId, plataforma: "meta" } },
        { id: "t2", name: "pausar_campanha", input: { client_id: clientId, plataforma: "meta", campaign_id: "c1" } },
      ],
    },
    { text: "Pausei a campanha Leads." },
  ]);
  const engine = engineFor(model, f.fn);
  const runId = await startRun(engine, { xodoId: xodo.id, agencyId, trigger: "user", text: "Pausa a Leads", userId: ownerId });
  assert.equal(await continueRun(engine, runId), "waiting_approval");
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0, "nada foi pausado antes da aprovação");

  const pending = await one<{ id: string }>(sql, `select id from xodo_actions where run_id = $1 and status = 'pending'`, [runId]);
  await decideAction(engine, { actionId: pending!.id, agencyId, userId: ownerId, approve: true });
  const posts = f.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/c1$/);
  assert.equal(new URLSearchParams(posts[0].body).get("status"), "PAUSED");
  const listed = await one<{ result: { data: { campanhas: { verba_diaria_brl: number }[] } } }>(
    sql,
    `select result from xodo_actions where run_id = $1 and tool_name = 'listar_campanhas'`,
    [runId],
  );
  assert.equal(listed!.result.data.campanhas[0].verba_diaria_brl, 100);
});

test("verba: dentro do limite roda sozinha; acima do limite sempre pede aprovação, mesmo agindo sozinho", async () => {
  const { xodo, agencyId, ownerId, clientId, f } = await xodoWithMeta("age_sozinho", { campaign_max_daily_brl: 300 });
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "ajustar_verba_diaria", input: { client_id: clientId, plataforma: "meta", campaign_id: "c1", nova_verba_brl: 115 } },
        { id: "t2", name: "ajustar_verba_diaria", input: { client_id: clientId, plataforma: "meta", campaign_id: "c1", nova_verba_brl: 180 } },
        { id: "t3", name: "ajustar_verba_diaria", input: { client_id: clientId, plataforma: "meta", campaign_id: "c1", nova_verba_brl: 500 } },
      ],
    },
  ]);
  const engine = engineFor(model, f.fn);
  const runId = await startRun(engine, { xodoId: xodo.id, agencyId, trigger: "user", text: "Ajusta as verbas", userId: ownerId });
  assert.equal(await continueRun(engine, runId), "waiting_approval");
  const actions = await sql.query<{ status: string; reason: string | null }>(
    `select status, reason from xodo_actions where run_id = $1 order by call_index`,
    [runId],
  );
  assert.deepEqual(actions.map((a) => a.status), ["executed", "pending", "pending"]);
  assert.match(actions[1].reason!, /mudança de 80%, acima do limite de 20%/);
  assert.match(actions[2].reason!, /acima do teto de R\$\s?300,00/);
  // A mudança de 15% foi para a Meta em centavos.
  const post = f.calls.find((c) => c.method === "POST")!;
  assert.equal(new URLSearchParams(post.body).get("daily_budget"), "11500");
  const note = await one<{ text: string }>(sql, `select text from xodo_messages where run_id = $1 and role = 'note'`, [runId]);
  assert.match(note!.text, /acima do limite de 20%/);
});

test("cliente fora do alcance do xodó não tem conta acessível", async () => {
  const { xodo, agencyId, ownerId, f } = await xodoWithMeta();
  const hidden = await seedClient(sql, agencyId, "Outro cliente");
  await sql.query(`update xodos set client_scope = 'selected' where id = $1`, [xodo.id]);
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "listar_campanhas", input: { client_id: hidden, plataforma: "meta" } }] },
    { text: "Sem acesso." },
  ]);
  const engine = engineFor(model, f.fn);
  const runId = await startRun(engine, { xodoId: xodo.id, agencyId, trigger: "user", text: "Campanhas", userId: ownerId });
  await continueRun(engine, runId);
  assert.match(model.lastToolResults()[0].content, /fora do alcance/);
});

test("consultar_analytics soma o GA4 sincronizado por canal", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  const clientId = await seedClient(sql, agencyId, "Site");
  const xodo = await seedXodo(sql, agencyId);
  for (const [day, channel, sessions] of [["2026-10-01", "Organic Search", 40], ["2026-10-02", "Organic Search", 10], ["2026-10-01", "Paid Search", 20]] as const) {
    await sql.query(
      `insert into analytics_daily (agency_id, client_id, property_id, day, channel, sessions, users, key_events, revenue_cents)
       values ($1, $2, '123', $3::date, $4, $5, $5, 1, 1000)`,
      [agencyId, clientId, day, channel, sessions],
    );
  }
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "consultar_analytics", input: { client_id: clientId, inicio: "2026-10-01", fim: "2026-10-31", agrupar_por: "canal" } }] },
    { text: "ok" },
  ]);
  const engine = testDeps(sql, model);
  const runId = await startRun(engine, { xodoId: xodo.id, agencyId, trigger: "user", text: "GA4", userId: ownerId });
  await continueRun(engine, runId);
  const data = JSON.parse(model.lastToolResults()[0].content);
  assert.deepEqual(data.linhas, [
    { canal: "Organic Search", sessoes: 50, usuarios: 50, eventos_principais: 2, receita_brl: 20 },
    { canal: "Paid Search", sessoes: 20, usuarios: 20, eventos_principais: 1, receita_brl: 10 },
  ]);
});
