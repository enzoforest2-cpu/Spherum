import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { connectionFor } from "../src/lib/integrations/access";
import { classifyExternalTool } from "../src/lib/integrations/classify";
import { createMcpConnection } from "../src/lib/integrations/connections";
import { IntegrationError } from "../src/lib/integrations/http";
import { listMcpTools } from "../src/lib/integrations/mcp";
import { finishOAuth, startOAuth } from "../src/lib/integrations/oauth";
import { OAUTH_PROVIDERS, tiktokJson } from "../src/lib/integrations/oauth-providers";
import { access, readSecret, revokeConnection, saveConnection, loadConnection, type IntegrationDeps } from "../src/lib/integrations/store";
import { decideAction } from "../src/lib/xodos/actions";
import { one, type Sql } from "../src/lib/xodos/db";
import { continueRun, startRun, toolsFor } from "../src/lib/xodos/runner";
import { startMcpServer } from "./fixtures/mcp-server";
import { Clock, createTestDb, FakeModel, seedAgency, seedFx, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const APP_URL = "https://spherum.com.br";
let sql: Sql;

before(async () => {
  ({ sql } = await createTestDb());
  await seedFx(sql);
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
});

type Call = { url: string; method: string; body: string; headers: Headers };

/** fetch falso: responde por prefixo de URL e guarda as chamadas. */
function fakeFetch(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call = { url, method: init.method ?? "GET", body: String(init.body ?? ""), headers: new Headers(init.headers) };
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: "sem rota" }), { status: 404 });
    const out = routes[key](call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const deps = (fetch: typeof globalThis.fetch, clock = new Clock()): IntegrationDeps => ({
  sql,
  masterKey: MASTER,
  fetch,
  appUrl: APP_URL,
  now: clock.now,
});

// ---------------------------------------------------------------------------

test("classifica ferramentas de terceiros pelo nome, sem confiar só no aviso do servidor", () => {
  const cases: [string, object, string][] = [
    ["GMAIL_SEND_EMAIL", {}, "envio"],
    ["GMAIL_LIST_MESSAGES", {}, "leitura"],
    ["GMAIL_CREATE_EMAIL_DRAFT", {}, "alteracao"],
    ["REDDIT_GET_POST", {}, "leitura"],
    ["create_comment", {}, "envio"],
    ["notion-create-page", {}, "alteracao"],
    ["delete_file", {}, "exclusao"],
    ["stripe_charge_customer", {}, "pagamento"],
    ["mcp__drive__searchFiles", {}, "leitura"],
    ["weather", { readOnlyHint: true }, "alteracao"],
    ["list_notes", { destructiveHint: true }, "exclusao"],
  ];
  for (const [name, hints, expected] of cases) assert.equal(classifyExternalTool(name, hints), expected, name);
});

test("login com o Google: URL com PKCE, troca do código, conta gravada cifrada e state de uso único", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  const google = fakeFetch({
    "https://oauth2.googleapis.com/token": () => ({
      access_token: "ya29.acesso",
      refresh_token: "1//refresh",
      expires_in: 3600,
      scope: "openid email https://www.googleapis.com/auth/gmail.modify",
    }),
    "https://openidconnect.googleapis.com/v1/userinfo": () => ({ email: "ana@agencia.com.br", name: "Ana" }),
  });
  const d = deps(google.fn);
  const url = new URL(await startOAuth(d, { agencyId, userId: ownerId, provider: "google", apps: ["gmail"], returnTo: "//evil.com" }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://spherum.com.br/api/integrations/google/callback");
  assert.match(url.searchParams.get("scope")!, /openid .*gmail\.modify/);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state")!;

  const result = await finishOAuth(d, { provider: "google", code: "codigo", state });
  assert.equal(result.returnTo, "/agencia", "retorno externo é trocado por um caminho interno");
  // O verificador do PKCE enviado bate com o desafio da URL.
  const verifier = new URLSearchParams(google.calls[0].body).get("code_verifier")!;
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), url.searchParams.get("code_challenge"));

  const conn = await loadConnection(sql, agencyId, result.connectionId);
  assert.deepEqual([conn.provider, conn.external_account, conn.label], ["google", "ana@agencia.com.br", "Ana (ana@agencia.com.br)"]);
  assert.ok(conn.scopes.includes("https://www.googleapis.com/auth/gmail.modify"));
  assert.ok(!conn.ciphertext.includes("ya29"));
  assert.deepEqual(await readSecret(d, conn), { accessToken: "ya29.acesso", refreshToken: "1//refresh" });

  await assert.rejects(finishOAuth(d, { provider: "google", code: "codigo", state }), /venceu ou já foi usado/);
});

test("reconectar a mesma conta soma permissões e não duplica; state vencido é recusado", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  const clock = new Clock();
  let scope = "https://www.googleapis.com/auth/gmail.modify";
  const google = fakeFetch({
    "https://oauth2.googleapis.com/token": () => ({ access_token: "a", refresh_token: "r", expires_in: 3600, scope }),
    "https://openidconnect.googleapis.com/v1/userinfo": () => ({ email: "ana@agencia.com.br" }),
  });
  const d = deps(google.fn, clock);
  const connect = async (apps: ("gmail" | "calendar")[]) => {
    const state = new URL(await startOAuth(d, { agencyId, userId: ownerId, provider: "google", apps })).searchParams.get("state")!;
    return finishOAuth(d, { provider: "google", code: "c", state });
  };
  const first = await connect(["gmail"]);
  scope = "https://www.googleapis.com/auth/calendar.events";
  const second = await connect(["calendar"]);
  assert.equal(second.connectionId, first.connectionId);
  const conn = await loadConnection(sql, agencyId, first.connectionId);
  assert.deepEqual(conn.scopes.sort(), ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.modify"]);

  const state = new URL(await startOAuth(d, { agencyId, userId: ownerId, provider: "google", apps: ["gmail"] })).searchParams.get("state")!;
  clock.advance(11 * 60 * 1000);
  await assert.rejects(finishOAuth(d, { provider: "google", code: "c", state }), /venceu/);
  await assert.rejects(startOAuth(d, { agencyId, userId: ownerId, provider: "google", apps: ["meta_ads"] }), /não usa o login/);
});

test("renova o token perto de vencer, uma vez só mesmo com chamadas simultâneas", async () => {
  const { agencyId } = await seedAgency(sql);
  const clock = new Clock();
  let refreshes = 0;
  const google = fakeFetch({
    "https://oauth2.googleapis.com/token": () => {
      refreshes += 1;
      return { access_token: `novo-${refreshes}`, expires_in: 3600 };
    },
  });
  const d = deps(google.fn, clock);
  const id = await saveConnection(d, {
    agencyId,
    provider: "google",
    label: "Ana",
    account: "ana@x.com",
    secret: { accessToken: "velho", refreshToken: "r1" },
    expiresAt: new Date(clock.current.getTime() + 60_000),
  });
  const [a, b] = await Promise.all([access(d, agencyId, id), access(d, agencyId, id)]);
  assert.equal(refreshes, 1);
  assert.equal(a.accessToken, "novo-1");
  assert.equal(b.accessToken, "novo-1");
  // Com o token novo válido, não renova de novo.
  assert.equal((await access(d, agencyId, id)).accessToken, "novo-1");
  assert.equal(refreshes, 1);
  // O refresh token foi mantido (o Google não manda outro).
  assert.equal((await readSecret(d, await loadConnection(sql, agencyId, id))).refreshToken, "r1");
});

test("refresh recusado marca a conexão como vencida e pede para reconectar", async () => {
  const { agencyId } = await seedAgency(sql);
  const clock = new Clock();
  const google = fakeFetch({
    "https://oauth2.googleapis.com/token": () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }),
  });
  const d = deps(google.fn, clock);
  const id = await saveConnection(d, {
    agencyId,
    provider: "google",
    label: "Ana",
    account: "ana@y.com",
    secret: { accessToken: "velho", refreshToken: "r1" },
    expiresAt: new Date(clock.current.getTime() - 1000),
  });
  await assert.rejects(access(d, agencyId, id), (e: unknown) => e instanceof IntegrationError && e.reauth && /Reconecte/.test(e.message));
  assert.equal((await loadConnection(sql, agencyId, id)).status, "expired");
  await assert.rejects(access(d, agencyId, id), /venceu/);
});

test("o app precisa estar liberado ao xodó e a conexão precisa ter a permissão do app", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId);
  const d = deps(fakeFetch({}).fn);
  await assert.rejects(connectionFor(sql, xodo, "gmail"), /não está liberado/);
  await sql.query(`insert into xodo_apps (xodo_id, agency_id, app) values ($1, $2, 'gmail')`, [xodo.id, agencyId]);
  await assert.rejects(connectionFor(sql, xodo, "gmail"), /ainda não conectou Gmail/);
  const onlyCalendar = await saveConnection(d, {
    agencyId,
    provider: "google",
    label: "Agenda",
    account: "a@a.com",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    secret: { accessToken: "t" },
  });
  await assert.rejects(connectionFor(sql, xodo, "gmail"), /Reconecte Gmail/);
  const withGmail = await saveConnection(d, {
    agencyId,
    provider: "google",
    label: "Gmail",
    account: "b@b.com",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    secret: { accessToken: "t" },
  });
  assert.equal(await connectionFor(sql, xodo, "gmail"), withGmail);
  // Conexão fixada no xodó vence a escolha automática.
  await sql.query(`update xodo_apps set connection_id = $1 where xodo_id = $2`, [onlyCalendar, xodo.id]);
  assert.equal(await connectionFor(sql, xodo, "gmail"), onlyCalendar);
});

test("particularidades das plataformas: Meta troca por token longo, TikTok e GitHub com erro em 200, Slack ok:false", async () => {
  const meta = fakeFetch({
    "https://graph.facebook.com/v23.0/oauth/access_token?client_id": () => ({ access_token: "curto" }),
    "https://graph.facebook.com/v23.0/oauth/access_token?grant_type=fb_exchange_token": () => ({ access_token: "longo", expires_in: 5_184_000 }),
    "https://graph.facebook.com/v23.0/me/permissions": () => ({ data: [{ permission: "ads_read", status: "granted" }, { permission: "ads_management", status: "declined" }] }),
  });
  const creds = { clientId: "id", clientSecret: "s", redirectUri: `${APP_URL}/api/integrations/meta/callback` };
  const tokens = await OAUTH_PROVIDERS.meta.exchange("c", creds, meta.fn);
  assert.equal(tokens.accessToken, "longo");
  assert.deepEqual(tokens.scopes, ["ads_read"]);
  assert.equal(tokens.expiresIn, 5_184_000);

  const tiktok = fakeFetch({ "https://business-api.tiktok.com": () => ({ code: 40105, message: "Access token expired" }) });
  await assert.rejects(tiktokJson(tiktok.fn, "/user/info/"), (e: unknown) => e instanceof IntegrationError && e.reauth);

  const github = fakeFetch({ "https://github.com/login/oauth/access_token": () => ({ error: "bad_verification_code", error_description: "The code is incorrect" }) });
  await assert.rejects(OAUTH_PROVIDERS.github.exchange("c", creds, github.fn), /code is incorrect/);

  const slack = fakeFetch({ "https://slack.com/api/oauth.v2.access": () => ({ ok: false, error: "invalid_code" }) });
  await assert.rejects(OAUTH_PROVIDERS.slack.exchange("c", creds, slack.fn), /invalid_code/);
});

test("desconectar revoga na plataforma e apaga os tokens", async () => {
  const { agencyId } = await seedAgency(sql);
  const google = fakeFetch({ "https://oauth2.googleapis.com/revoke": () => ({}) });
  const d = deps(google.fn);
  const id = await saveConnection(d, { agencyId, provider: "google", label: "Ana", account: "z@z.com", secret: { accessToken: "a", refreshToken: "r" } });
  await revokeConnection(d, agencyId, id);
  assert.match(google.calls[0].body, /token=r/);
  const conn = await loadConnection(sql, agencyId, id);
  assert.equal(conn.status, "revoked");
  assert.deepEqual(await readSecret(d, conn), {});
  await assert.rejects(access(d, agencyId, id), /desconectada/);
});

// ---------------------------------------------------------------------------
// MCP de ponta a ponta, com um servidor de verdade
// ---------------------------------------------------------------------------

let mcp: Awaited<ReturnType<typeof startMcpServer>>;
before(async () => {
  mcp = await startMcpServer();
});
after(async () => {
  await mcp.close();
});

test("servidor MCP: lista ferramentas já classificadas e exige o token", async () => {
  const tools = await listMcpTools(mcp.url, mcp.token, fetch);
  assert.deepEqual(
    tools.map((t) => [t.name, t.category]),
    [["list_notes", "leitura"], ["send_message", "envio"], ["wipe_notes", "exclusao"]],
  );
  await assert.rejects(listMcpTools(mcp.url, "errado", fetch), IntegrationError);
  // Endereço local não é aceito ao cadastrar (proteção contra SSRF).
  const { agencyId, ownerId } = await seedAgency(sql);
  await assert.rejects(
    createMcpConnection(deps(fetch), agencyId, { provider: "mcp", label: "Local", url: mcp.url, token: mcp.token }, ownerId),
    /rede privada|locais/,
  );
});

test("xodó com o app MCP: lê direto, e enviar espera aprovação e roda uma vez no servidor", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId);
  const d = deps(fetch);
  await saveConnection(d, { agencyId, provider: "mcp", label: "Notas", account: mcp.url, secret: { apiKey: mcp.token }, metadata: { url: mcp.url } });
  const engine = { ...testDeps(sql, new FakeModel([])), integrations: { masterKey: MASTER, fetch, appUrl: APP_URL } };

  // Sem o app liberado, as ferramentas MCP não aparecem.
  assert.ok(!(await toolsFor(engine, xodo)).some((t) => t.app === "mcp"));
  await sql.query(`insert into xodo_apps (xodo_id, agency_id, app) values ($1, $2, 'mcp')`, [xodo.id, agencyId]);
  const names = (await toolsFor(engine, xodo)).filter((t) => t.app === "mcp").map((t) => t.name);
  assert.equal(names.length, 3);
  const list = names.find((n) => n.endsWith("list_notes"))!;
  const send = names.find((n) => n.endsWith("send_message"))!;

  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: list, input: {} }, { id: "t2", name: send, input: { to: "cliente@x.com", text: "Oi" } }] },
    { text: "Li as notas e mandei a mensagem." },
  ]);
  const run = { ...engine, llm: model.llm };
  const runId = await startRun(run, { xodoId: xodo.id, agencyId, trigger: "user", text: "Veja as notas e avise o cliente", userId: ownerId });
  assert.equal(await continueRun(run, runId), "waiting_approval");
  assert.deepEqual(mcp.calls.map((c) => c.name), ["list_notes"], "a leitura rodou; o envio esperou");

  const pending = await one<{ id: string }>(sql, `select id from xodo_actions where run_id = $1 and status = 'pending'`, [runId]);
  const decided = await decideAction(run, { actionId: pending!.id, agencyId, userId: ownerId, approve: true });
  assert.equal(decided.status, "executed");
  assert.deepEqual(mcp.calls.map((c) => c.name), ["list_notes", "send_message"]);
  assert.deepEqual(mcp.calls[1].args, { to: "cliente@x.com", text: "Oi" });
});
