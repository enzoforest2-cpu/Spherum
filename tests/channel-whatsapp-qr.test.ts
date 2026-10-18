import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ZodError } from "zod";
import { createPairingCode } from "../src/lib/channels/pairing";
import { randomToken, sha256Hex } from "../src/lib/channels/security";
import { ChannelError, type ChannelDeps, type OutboundApproval } from "../src/lib/channels/types";
import {
  approvalInstructions,
  authenticateWhatsappQr,
  createWhatsappQrConnection,
  handleWhatsappQr,
  parseEvolutionWebhook,
  qrImage,
  SESSION_DROPPED,
  toWhatsappText,
  whatsappQrAdapter,
  whatsappQrStatus,
  WHATSAPP_QR_RISKS,
} from "../src/lib/channels/whatsapp-qr";
import { IntegrationError } from "../src/lib/integrations/http";
import { access, loadConnection, readSecret, saveConnection, type IntegrationDeps } from "../src/lib/integrations/store";
import { one, type Sql } from "../src/lib/xodos/db";
import type { Resolver } from "../src/lib/xodos/net";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const NOW = new Date("2026-10-19T12:00:00Z");
const APP_URL = "https://spherum.com.br";
const HOST_BASE = "https://evo.agencia.com.br";
/** IP público literal: o envio confere o endereço de novo, e assim não precisa de DNS. */
const IP_BASE = "https://200.147.67.142:8080";
const KEY = "chave-global-da-evolution-123";
const FROM = "5511987654321";
const INSTANCE = "agencia-teste";
const QR = `data:image/png;base64,iVBORw0KGgo${"A".repeat(200)}`;
const BARE_QR = `iVBORw0KGgo${"B".repeat(200)}`;

const resolver: Resolver = async (hostname) => [{ address: hostname.includes("interno") ? "192.168.0.10" : "200.147.67.142" }];

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
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

const evoError = (status: number, ...message: unknown[]) =>
  new Response(JSON.stringify({ status, error: status === 401 ? "Unauthorized" : "Bad Request", response: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Evolution falsa: instâncias, estado da sessão, QR e envio; `fail` troca a resposta de um caminho. */
function fakeEvolution(base: string) {
  const s = {
    state: "close",
    exists: new Set<string>(),
    createQr: QR as string | null,
    connectQr: QR as string,
    fail: {} as Record<string, (c: Call) => Response>,
  };
  const f = fakeFetch((c) => {
    if (!c.url.startsWith(base)) return evoError(404, "Not Found");
    const p = c.url.slice(base.length);
    for (const [prefix, make] of Object.entries(s.fail)) if (p.startsWith(prefix)) return make(c);
    if (c.headers.get("apikey") !== KEY) return evoError(401, "Unauthorized");
    let m: RegExpMatchArray | null;
    if (c.method === "POST" && p === "/instance/create") {
      const body = JSON.parse(c.body) as { instanceName: string; integration: string };
      if (s.exists.has(body.instanceName)) return evoError(403, `This name "${body.instanceName}" is already in use.`);
      s.exists.add(body.instanceName);
      s.state = "connecting";
      return {
        instance: { instanceName: body.instanceName, instanceId: "i-1", integration: body.integration, status: "connecting" },
        hash: "HASH-DA-INSTANCIA",
        qrcode: s.createQr ? { pairingCode: null, code: "2@abc", base64: s.createQr, count: 1 } : { count: 0 },
      };
    }
    if (c.method === "POST" && (m = p.match(/^\/webhook\/set\/(.+)$/))) return { webhook: { instanceId: "i-1", ...JSON.parse(c.body).webhook } };
    if ((m = p.match(/^\/instance\/(connectionState|connect)\/(.+)$/))) {
      const name = decodeURIComponent(m[2]);
      if (!s.exists.has(name)) return evoError(404, `The "${name}" instance does not exist`);
      if (m[1] === "connectionState" || s.state === "open") return { instance: { instanceName: name, state: s.state } };
      if (s.state === "refused") return { instance: { instanceName: name, status: "refused" }, qrcode: { pairingCode: null, count: 30 } };
      s.state = "connecting";
      return { pairingCode: null, code: "2@def", base64: s.connectQr, count: 2 };
    }
    if (c.method === "POST" && (m = p.match(/^\/message\/sendText\/(.+)$/))) {
      const body = JSON.parse(c.body) as { number: string };
      return { key: { remoteJid: `${body.number}@s.whatsapp.net`, fromMe: true, id: "3EB0SAIDA" }, status: "PENDING" };
    }
    return evoError(404, "Not Found");
  });
  const sends = () => f.calls.filter((c) => c.url.includes("/message/sendText/")).map((c) => JSON.parse(c.body) as { number: string; text: string });
  return { ...f, s, sends };
}

async function connect(base = IP_BASE, extra: Record<string, unknown> = {}, ev = fakeEvolution(base.replace(/\/+$/, ""))) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: ev.fn, appUrl: APP_URL, now: () => NOW };
  const result = await createWhatsappQrConnection(deps, agencyId, { base_url: base, api_key: KEY, accept_risks: true, ...extra }, ownerId, resolver);
  const hookCall = ev.calls.find((c) => c.url.includes("/webhook/set/"));
  const url = hookCall ? (JSON.parse(hookCall.body).webhook.url as string) : null;
  return { ev, deps, agencyId, ownerId, result, url, token: url ? url.split("/").at(-1)! : "" };
}

let seq = 0;
function upsert(text: string, o: { from?: string; at?: Date; fromMe?: boolean; event?: string; instance?: string } = {}) {
  return {
    event: o.event ?? "messages.upsert",
    instance: o.instance ?? INSTANCE,
    data: {
      key: { remoteJid: `${o.from ?? FROM}@s.whatsapp.net`, fromMe: o.fromMe ?? false, id: `3EB0${(seq += 1)}` },
      pushName: "Ana",
      message: { conversation: text },
      messageType: "conversation",
      messageTimestamp: Math.floor((o.at ?? NOW).getTime() / 1000),
    },
    destination: `${APP_URL}/api/channels/whatsapp-qr/x/y`,
    date_time: NOW.toISOString(),
    sender: "5511400000000@s.whatsapp.net",
    server_url: IP_BASE,
    apikey: "CHAVE-DA-INSTANCIA",
  };
}

async function world(opts: { autonomy?: string } = {}) {
  const c = await connect(IP_BASE, { instance: INSTANCE });
  const clock = new Clock(new Date(NOW));
  const xodo = await seedXodo(sql, c.agencyId, { autonomy: opts.autonomy ?? "pergunta_no_que_importa" });
  await sql.query(`insert into xodo_channels (agency_id, xodo_id, connection_id) values ($1, $2, $3)`, [c.agencyId, xodo.id, c.result.id]);
  const deps = (model: FakeModel): ChannelDeps => ({ ...testDeps(sql, model, clock), integrations: { masterKey: MASTER, fetch: c.ev.fn, appUrl: APP_URL } });
  const hook = (await authenticateWhatsappQr(c.deps, c.result.id, c.token))!;
  const deliver = (payload: unknown, model = new FakeModel([])) => handleWhatsappQr(deps(model), { whatsapp_qr: whatsappQrAdapter }, hook, payload);
  const pair = async () => {
    const { code } = await createPairingCode(sql, c.agencyId, c.ownerId, clock.now());
    return deliver(upsert(code));
  };
  return { ...c, clock, xodo, hook, deliver, pair };
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

test("riscos: sem accept_risks: true literal a conexão é recusada com a lista de riscos", async () => {
  assert.ok(WHATSAPP_QR_RISKS.length >= 6);
  const all = WHATSAPP_QR_RISKS.join(" ");
  for (const word of [/banido/, /número dedicado/, /QR Code de novo/, /gateway vê todas as mensagens/, /forjar mensagens/, /disparos em massa/, /garantia de entrega/]) {
    assert.match(all, word);
  }
  const ev = fakeEvolution(HOST_BASE);
  const { agencyId, ownerId } = await seedAgency(sql);
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: ev.fn, appUrl: APP_URL };
  for (const accept of [undefined, false, "true", 1]) {
    await assert.rejects(
      createWhatsappQrConnection(deps, agencyId, { base_url: HOST_BASE, api_key: KEY, accept_risks: accept }, ownerId, resolver),
      (error: unknown) =>
        error instanceof IntegrationError && error.status === 400 && WHATSAPP_QR_RISKS.every((risk) => error.message.includes(risk)),
    );
  }
  assert.equal(ev.calls.length, 0, "nada vai ao gateway");
  assert.equal((await sql.query(`select 1 from integration_connections where agency_id = $1`, [agencyId])).length, 0);
});

test("endereço do gateway: rede interna, esquema errado, senha na URL e entrada inválida são recusados", async () => {
  const ev = fakeEvolution(HOST_BASE);
  const { agencyId, ownerId } = await seedAgency(sql);
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: ev.fn, appUrl: APP_URL };
  const bad = [
    "http://localhost:8080",
    "http://10.0.0.5:8080",
    "http://169.254.169.254",
    "https://evo.interno.com.br",
    "ftp://evo.agencia.com.br",
    "https://usuario:senha@evo.agencia.com.br",
    "https://evo.agencia.com.br/?x=1",
    "não é endereço",
  ];
  for (const base_url of bad) {
    await assert.rejects(
      createWhatsappQrConnection(deps, agencyId, { base_url, api_key: KEY, accept_risks: true }, ownerId, resolver),
      (error: unknown) => error instanceof IntegrationError && error.status === 400 && /gateway/.test(error.message),
      base_url,
    );
  }
  await assert.rejects(
    createWhatsappQrConnection(deps, agencyId, { base_url: HOST_BASE, api_key: KEY, instance: "nome com espaço", accept_risks: true }, ownerId, resolver),
    ZodError,
  );
  await assert.rejects(
    createWhatsappQrConnection(deps, agencyId, { base_url: HOST_BASE, api_key: "curta", accept_risks: true }, ownerId, resolver),
    ZodError,
  );
  assert.equal(ev.calls.length, 0);
  assert.equal((await sql.query(`select 1 from integration_connections where agency_id = $1`, [agencyId])).length, 0);
});

test("cria a conexão: guarda só o hash do token, cria a instância, aponta o webhook e devolve o QR", async () => {
  const c = await connect(`${HOST_BASE}/`);
  const [create, webhook, ...rest] = c.ev.calls;
  assert.equal(rest.length, 0, "o QR veio no create; não precisa do connect");

  assert.equal(create.method, "POST");
  assert.equal(create.url, `${HOST_BASE}/instance/create`);
  assert.equal(create.headers.get("apikey"), KEY);
  const created = JSON.parse(create.body);
  assert.match(created.instanceName, /^spherum-[0-9a-f]{8}$/);
  assert.deepEqual(created, { instanceName: created.instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" });
  const instance = created.instanceName as string;

  assert.equal(webhook.url, `${HOST_BASE}/webhook/set/${instance}`);
  assert.equal(webhook.headers.get("apikey"), KEY);
  assert.match(c.token, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(JSON.parse(webhook.body), {
    webhook: {
      enabled: true,
      url: `${APP_URL}/api/channels/whatsapp-qr/${c.result.id}/${c.token}`,
      byEvents: false,
      base64: false,
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
    },
  });
  assert.deepEqual(c.result, { id: c.result.id, status: "aguardando_qr", qr: QR });

  const row = await loadConnection(sql, c.agencyId, c.result.id);
  assert.equal(row.provider, "whatsapp_qr");
  assert.equal(row.status, "active");
  assert.equal(row.label, `WhatsApp QR (${instance})`);
  assert.equal(row.external_account, `${HOST_BASE}#${instance}`);
  assert.deepEqual({ base_url: row.metadata.base_url, instance: row.metadata.instance, state: row.metadata.state }, {
    base_url: HOST_BASE,
    instance,
    state: "connecting",
  });
  const secret = await readSecret(c.deps, row);
  assert.deepEqual(secret, { apiKey: KEY, extra: { webhook_token_hash: sha256Hex(c.token) } });
  assert.ok(!JSON.stringify(secret).includes(c.token), "o token da URL não fica guardado");
  assert.ok(!JSON.stringify(row.metadata).includes(c.token) && !JSON.stringify(row.metadata).includes(KEY), "metadata sem segredo");
});

test("entrada: só o token certo autentica; errado, malformado, conexão inexistente ou revogada dão null", async () => {
  const c = await connect(HOST_BASE, { instance: "autentica" });
  assert.deepEqual(await authenticateWhatsappQr(c.deps, c.result.id, c.token), { id: c.result.id, agencyId: c.agencyId, instance: "autentica" });
  const flipped = `${c.token.slice(0, -1)}${c.token.endsWith("A") ? "B" : "A"}`;
  for (const [connectionId, token] of [
    [c.result.id, randomToken()],
    [c.result.id, flipped],
    [c.result.id, "abc"],
    [c.result.id, "../../etc/passwd"],
    ["0b9d2f4e-1c3a-4e5f-8a7b-6c5d4e3f2a1b", c.token],
    ["nao-e-uuid", c.token],
  ]) {
    assert.equal(await authenticateWhatsappQr(c.deps, connectionId, token), null, `${connectionId} ${token}`);
  }
  // Reconectar a mesma instância troca o token: o antigo para de valer.
  const again = await createWhatsappQrConnection(c.deps, c.agencyId, { base_url: HOST_BASE, api_key: KEY, instance: "autentica", accept_risks: true }, c.ownerId, resolver);
  assert.equal(again.id, c.result.id, "mesma conta, mesma conexão");
  const newToken = (JSON.parse(c.ev.calls.filter((x) => x.url.includes("/webhook/set/")).at(-1)!.body).webhook.url as string).split("/").at(-1)!;
  assert.equal(await authenticateWhatsappQr(c.deps, c.result.id, c.token), null);
  assert.ok(await authenticateWhatsappQr(c.deps, c.result.id, newToken));

  await sql.query(`update integration_connections set status = 'revoked' where id = $1`, [c.result.id]);
  assert.equal(await authenticateWhatsappQr(c.deps, c.result.id, newToken), null);
});

test("instância que já existe é reaproveitada e o QR vem do connect; QR que não é PNG não passa", async () => {
  const ev = fakeEvolution(HOST_BASE);
  ev.s.exists.add(INSTANCE);
  ev.s.connectQr = BARE_QR;
  const c = await connect(HOST_BASE, { instance: INSTANCE, label: "Número do xodó" }, ev);
  assert.deepEqual(
    ev.calls.map((x) => `${x.method} ${x.url.slice(HOST_BASE.length)}`),
    [`POST /instance/create`, `GET /instance/connectionState/${INSTANCE}`, `POST /webhook/set/${INSTANCE}`, `GET /instance/connect/${INSTANCE}`],
  );
  assert.deepEqual(c.result, { id: c.result.id, status: "aguardando_qr", qr: `data:image/png;base64,${BARE_QR}` });
  assert.equal((await loadConnection(sql, c.agencyId, c.result.id)).label, "Número do xodó");

  assert.equal(qrImage(QR), QR);
  assert.equal(qrImage("data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"), null);
  assert.equal(qrImage("javascript:alert(1)"), null);
  assert.equal(qrImage(`data:image/png;base64,${"A".repeat(300_000)}`), null, "grande demais");
  assert.equal(qrImage(42), null);
  assert.equal(qrImage("abc"), null);
});

test("gateway falha depois de gravar: a conexão fica com erro, a mensagem é clara e não vaza o token", async () => {
  const ev = fakeEvolution(HOST_BASE);
  // O token fica bem no corte de 200 caracteres: se a troca por *** viesse depois, vazaria um pedaço.
  ev.s.fail["/webhook/set/"] = (call) => evoError(500, `Invalid url ${"x".repeat(90)} ${JSON.parse(call.body).webhook.url}`);
  const { agencyId, ownerId } = await seedAgency(sql);
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: ev.fn, appUrl: APP_URL };
  let thrown: unknown;
  await createWhatsappQrConnection(deps, agencyId, { base_url: HOST_BASE, api_key: KEY, accept_risks: true }, ownerId, resolver).catch((e) => (thrown = e));
  assert.ok(thrown instanceof IntegrationError);
  assert.equal(thrown.status, 502);
  assert.match(thrown.message, /O gateway recusou: Invalid url .*\*\*\*.*\[HTTP 500\]\. A conexão ficou marcada com erro/);
  const token = (JSON.parse(ev.calls.find((x) => x.url.includes("/webhook/set/"))!.body).webhook.url as string).split("/").at(-1)!;
  assert.ok(!thrown.message.includes(token.slice(0, 8)), "nem um pedaço do token");
  const row = await one<{ status: string; last_error: string }>(sql, `select status, last_error from integration_connections where agency_id = $1`, [agencyId]);
  assert.equal(row!.status, "error");
  assert.ok(row!.last_error.includes("***") && !row!.last_error.includes(token));

  // Chave errada: o create e a instância recusam.
  const wrong = await seedAgency(sql);
  await assert.rejects(
    createWhatsappQrConnection(deps, wrong.agencyId, { base_url: HOST_BASE, api_key: "chave-errada-123", accept_risks: true }, wrong.ownerId, resolver),
    (error: unknown) => error instanceof IntegrationError && error.status === 400 && error.reauth && /recusou a chave/.test(error.message),
  );
  const wrongRow = await one<{ status: string; last_error: string }>(sql, `select status, last_error from integration_connections where agency_id = $1`, [wrong.agencyId]);
  assert.equal(wrongRow!.status, "error");
  assert.match(wrongRow!.last_error, /apikey/);
});

test("gateway fora do ar, lento ou redirecionando: mensagens claras", async () => {
  const cases: [string, () => never | Response, RegExp][] = [
    [
      "fora do ar",
      () => {
        throw new TypeError("fetch failed");
      },
      /Não consegui falar com o gateway do WhatsApp \(evo\.agencia\.com\.br\)/,
    ],
    [
      "lento",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      /não respondeu a tempo/,
    ],
    ["redirecionando", () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }), /redirecionamento/],
    // Endereço do painel ou de um site qualquer: 200 com HTML não pode passar por sucesso.
    ["não é a API", () => new Response("<html>Evolution Manager</html>", { status: 200, headers: { "content-type": "text/html" } }), /não respondeu como a Evolution API/],
    // Resposta em pedaços, sem Content-Length e sem fim: a leitura para no limite.
    ["grande demais", () => new Response(new ReadableStream({ pull: (ctrl) => ctrl.enqueue(new Uint8Array(256 * 1024)) })), /grande demais/],
    [
      "lento no corpo",
      () => new Response(new ReadableStream({ pull: (ctrl) => ctrl.error(new DOMException("The operation was aborted due to timeout", "TimeoutError")) })),
      /não respondeu a tempo/,
    ],
  ];
  for (const [name, respond, expected] of cases) {
    const f = fakeFetch(respond);
    const { agencyId, ownerId } = await seedAgency(sql);
    const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: f.fn, appUrl: APP_URL };
    await assert.rejects(
      createWhatsappQrConnection(deps, agencyId, { base_url: HOST_BASE, api_key: KEY, accept_risks: true }, ownerId, resolver),
      (error: unknown) => error instanceof IntegrationError && expected.test(error.message),
      name,
    );
    const row = await one<{ status: string }>(sql, `select status from integration_connections where agency_id = $1`, [agencyId]);
    assert.equal(row!.status, "error", name);
  }
});

test("situação: open = conectado; connecting/close pedem QR novo; limite de QR = desconectado", async () => {
  const c = await connect(HOST_BASE, { instance: "situacao" });
  const status = () => whatsappQrStatus(c.deps, c.agencyId, c.result.id, resolver);
  c.ev.s.state = "open";
  assert.deepEqual(await status(), { status: "conectado", qr: null });
  assert.equal((await loadConnection(sql, c.agencyId, c.result.id)).metadata.state, "open");

  c.ev.s.state = "close";
  c.ev.s.connectQr = `data:image/png;base64,${"C".repeat(200)}`;
  const before = c.ev.calls.length;
  assert.deepEqual(await status(), { status: "aguardando_qr", qr: c.ev.s.connectQr });
  assert.deepEqual(
    c.ev.calls.slice(before).map((x) => x.url.slice(HOST_BASE.length)),
    ["/instance/connectionState/situacao", "/instance/connect/situacao"],
  );
  assert.equal((await loadConnection(sql, c.agencyId, c.result.id)).metadata.state, "close");

  c.ev.s.state = "connecting";
  assert.equal((await status()).status, "aguardando_qr");
  c.ev.s.state = "refused";
  assert.deepEqual(await status(), { status: "desconectado", qr: null });

  // Instância apagada no gateway, conexão de outra agência.
  c.ev.s.exists.delete("situacao");
  await assert.rejects(status(), (error: unknown) => error instanceof IntegrationError && error.status === 404 && /não existe no gateway/.test(error.message));
  const other = await seedAgency(sql);
  await assert.rejects(whatsappQrStatus(c.deps, other.agencyId, c.result.id, resolver), /Conexão não encontrada/);
  // Conexão de outro canal da mesma agência não vira gateway.
  const telegram = await saveConnection(c.deps, { agencyId: c.agencyId, provider: "telegram", label: "Bot", account: "bot-1", secret: { apiKey: "123:abc" } });
  await assert.rejects(whatsappQrStatus(c.deps, c.agencyId, telegram, resolver), (e: unknown) => e instanceof IntegrationError && e.status === 404);
  assert.equal(await authenticateWhatsappQr(c.deps, telegram, c.token), null);
});

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

test("parse: texto de conversa individual nas variações do payload; o resto fica de fora", () => {
  const base = upsert("Bom dia");
  assert.deepEqual(parseEvolutionWebhook(base), [
    { kind: "message", instance: INSTANCE, eventId: base.data.key.id, number: FROM, name: "Ana", text: "Bom dia", sentAt: NOW },
  ]);
  // Evento em maiúsculas, data em lista, texto em extendedTextMessage.
  const listed = {
    event: "MESSAGES_UPSERT",
    instance: INSTANCE,
    data: [
      { key: { remoteJid: `${FROM}@s.whatsapp.net`, fromMe: false, id: "A1" }, pushName: "Ana\nda Silva", message: { extendedTextMessage: { text: "  com link  " } } },
      { key: { remoteJid: `${FROM}@s.whatsapp.net`, fromMe: true, id: "A2" }, message: { conversation: "minha própria mensagem" } },
      { key: { remoteJid: "120363000000000000@g.us", fromMe: false, id: "A3", participant: `${FROM}@s.whatsapp.net` }, message: { conversation: "grupo" } },
      { key: { remoteJid: "status@broadcast", fromMe: false, id: "A4" }, message: { conversation: "status" } },
      { key: { remoteJid: `${FROM}@s.whatsapp.net`, fromMe: false, id: "A5" }, message: { imageMessage: { mimetype: "image/jpeg" } } },
      { key: { remoteJid: "123456789012345@lid", fromMe: false, id: "A6" }, message: { conversation: "lid sem número" } },
      { key: { remoteJid: "123456789012345@lid", remoteJidAlt: "5521999990000@s.whatsapp.net", fromMe: false, id: "A7" }, message: { conversation: "lid com número" } },
      { key: { remoteJid: `${FROM}@s.whatsapp.net`, id: "A8" }, message: { conversation: "sem fromMe" } },
      { key: { remoteJid: "1234567890@newsletter", fromMe: false, id: "A9" }, message: { conversation: "canal" } },
      "lixo",
      null,
    ],
  };
  const out = parseEvolutionWebhook(listed);
  assert.deepEqual(
    out.map((e) => (e.kind === "message" ? [e.eventId, e.number, e.text, e.name] : e.kind)),
    [
      ["A1", FROM, "com link", "Ana da Silva"],
      ["A7", "5521999990000", "lid com número", null],
    ],
  );
  assert.deepEqual(parseEvolutionWebhook({ event: "connection.update", instance: INSTANCE, data: { instance: INSTANCE, state: "open", statusReason: 200, wuid: "5511400000000:12@s.whatsapp.net" } }), [
    { kind: "connection", instance: INSTANCE, state: "open", number: "5511400000000" },
  ]);
  // Hora e nome em formato estranho (Long sem converter, número) não derrubam o texto.
  const odd = parseEvolutionWebhook({
    event: "messages.upsert",
    data: { key: { remoteJid: `${FROM}@s.whatsapp.net`, fromMe: false, id: "B1", remoteJidAlt: 42 }, pushName: 123, message: { conversation: "oi" }, messageTimestamp: { low: 1, high: 0 } },
  });
  assert.deepEqual(odd, [{ kind: "message", instance: null, eventId: "B1", number: FROM, name: null, text: "oi", sentAt: null }]);
  // Mensagens temporárias: o texto vem embrulhado.
  const ephemeral = parseEvolutionWebhook({
    event: "messages.upsert",
    data: { key: { remoteJid: `${FROM}@s.whatsapp.net`, fromMe: false, id: "B2" }, message: { ephemeralMessage: { message: { extendedTextMessage: { text: "sumindo" } } } } },
  });
  assert.deepEqual(ephemeral.map((e) => (e.kind === "message" ? e.text : e.kind)), ["sumindo"]);
  assert.equal((parseEvolutionWebhook({ ...upsert("x"), data: { ...upsert("x").data, messageTimestamp: "1792411200" } })[0] as { sentAt: Date }).sentAt.toISOString(), "2026-10-19T12:00:00.000Z");
  assert.deepEqual(parseEvolutionWebhook({ event: "CONNECTION_UPDATE", data: { state: "hackeado" } }), []);
  assert.deepEqual(parseEvolutionWebhook({ event: "qrcode.updated", data: { qrcode: { base64: QR } } }), []);
  assert.deepEqual(parseEvolutionWebhook(null), []);
  assert.deepEqual(parseEvolutionWebhook("texto"), []);
});

test("fluxo: desconhecido recebe a dica, o código vincula e o xodó responde pelo sendText", async () => {
  const w = await world();
  const first = await w.deliver(upsert("oi"));
  assert.equal(first.messages[0].status, "unknown_sender");
  assert.equal(w.ev.sends().at(-1)!.number, FROM);
  assert.match(w.ev.sends().at(-1)!.text, /gere um código no Spherum/);

  assert.equal((await w.pair()).messages[0].status, "paired");
  assert.match(w.ev.sends().at(-1)!.text, /vinculada/);

  const payload = upsert("Bom dia");
  const r = await w.deliver(payload, new FakeModel([{ text: "## Resumo\nBom dia, **Ana**! Veja [o painel](https://spherum.com.br/painel)." }]));
  assert.equal(r.messages[0].status, "started");
  const sent = w.ev.calls.at(-1)!;
  assert.equal(sent.url, `${IP_BASE}/message/sendText/${INSTANCE}`);
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.get("apikey"), KEY);
  assert.deepEqual(JSON.parse(sent.body), { number: FROM, text: "*Resumo*\nBom dia, *Ana*! Veja o painel (https://spherum.com.br/painel)." });
  const conv = await one<{ metadata: unknown; external_key: string; channel: string }>(
    sql,
    `select metadata, external_key, channel from xodo_conversations where xodo_id = $1`,
    [w.xodo.id],
  );
  assert.deepEqual(conv, { metadata: { number: FROM }, external_key: FROM, channel: "whatsapp" });

  assert.equal((await w.deliver(payload)).messages[0].status, "duplicate", "o gateway reenvia");
  assert.deepEqual((await w.deliver(upsert("velha", { at: new Date(NOW.getTime() - 2 * 3600_000) }))).messages, [
    { eventId: `3EB0${seq}`, status: "ignored", detail: "antiga" },
  ]);
  assert.deepEqual((await w.deliver(upsert("de outra instância", { instance: "outra" }))).messages, []);
  assert.deepEqual((await w.deliver(upsert("eco", { fromMe: true }))).messages, []);
});

test("aprovação por texto: o pedido chega com instruções e 'aprovar' decide pelo WhatsApp", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "avisar_equipe", input: { titulo: "Atenção", mensagem: "CPL subiu" } }] },
    { text: "Feito, avisei." },
  ]);
  await w.deliver(upsert("Avisa a equipe que o CPL subiu"), model);
  const ask = w.ev.sends().at(-1)!.text;
  assert.match(ask, /Preciso de aprovação/);
  assert.match(ask, /Responda \*aprovar\* ou \*negar\*\.$/);

  const decided = await w.deliver(upsert("aprovar"), model);
  assert.equal(decided.messages[0].status, "decided");
  const action = await one<{ status: string; decided_via: string }>(sql, `select status, decided_via from xodo_actions where xodo_id = $1`, [w.xodo.id]);
  assert.deepEqual(action, { status: "executed", decided_via: "whatsapp" });
  assert.equal(w.ev.sends().at(-1)!.text, "Feito, avisei.");
});

test("aprovação por texto: o número mostrado é o que o núcleo entende, com pedido antigo ainda na conversa", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const ask = (id: string, titulo: string) => ({ id, name: "avisar_equipe", input: { titulo, mensagem: "" } });
  const model = new FakeModel([{ toolCalls: [ask("t1", "Antigo")] }, { toolCalls: [ask("t2", "Segundo"), ask("t3", "Terceiro")] }]);
  await w.deliver(upsert("Avisa do antigo"), model);
  assert.match(w.ev.sends().at(-1)!.text, /Responda \*aprovar\* ou \*negar\*\.$/);

  // Uma execução esperando aprovação não impede outra: agora há 3 pedidos na conversa.
  await w.deliver(upsert("Agora avisa do segundo e do terceiro"), model);
  const text = w.ev.sends().at(-1)!.text;
  assert.match(text, /\*aprovar 2\* ou \*negar 2\*: avisar a equipe: Segundo/);
  assert.match(text, /\*aprovar 3\* ou \*negar 3\*: avisar a equipe: Terceiro/);
  assert.doesNotMatch(text, /\*aprovar 1\*/, "o antigo não é desta mensagem");

  // "aprovar 2" decide exatamente o pedido mostrado com o 2.
  assert.equal((await w.deliver(upsert("aprovar 2"), model)).messages[0].status, "decided");
  const rows = await sql.query<{ tool_call_id: string; status: string }>(
    `select tool_call_id, status from xodo_actions where xodo_id = $1 order by tool_call_id`,
    [w.xodo.id],
  );
  assert.deepEqual(rows.map((r) => [r.tool_call_id, r.status]), [["t1", "pending"], ["t2", "executed"], ["t3", "pending"]]);

  // Um pedido só nesta mensagem, mas outros pendentes na conversa: vai com número, sem "aprovar" solto.
  const a = await access(w.deps, w.agencyId, w.result.id);
  const t3 = await one<{ id: string }>(sql, `select id from xodo_actions where xodo_id = $1 and tool_call_id = 't3'`, [w.xodo.id]);
  await whatsappQrAdapter.send({ deps: w.deps, access: a, target: { number: FROM }, xodoName: "Pipoca" }, {
    text: "Ainda falta:",
    approvals: [{ actionId: t3!.id, summary: "avisar a equipe: Terceiro", index: 1 }],
  });
  assert.equal(w.ev.sends().at(-1)!.text, "Ainda falta:\n\nPara decidir, responda com o número do pedido:\n• *aprovar 2* ou *negar 2*: avisar a equipe: Terceiro");
});

test("connection.update: atualiza o estado sem segredo; 'open' tira o erro, 'close' pede QR de novo", async () => {
  const w = await world();
  await sql.query(`update integration_connections set status = 'error', last_error = 'falhou antes' where id = $1`, [w.result.id]);
  const update = (state: string) => ({
    event: "CONNECTION_UPDATE",
    instance: INSTANCE,
    data: { instance: INSTANCE, state, statusReason: 200, wuid: "5511400000000@s.whatsapp.net", profileName: "Agência" },
    apikey: "CHAVE-DA-INSTANCIA",
  });
  assert.equal((await w.deliver(update("open"))).state, "open");
  let row = await loadConnection(sql, w.agencyId, w.result.id);
  const last = await one<{ last_error: string | null }>(sql, `select last_error from integration_connections where id = $1`, [w.result.id]);
  assert.equal(row.status, "active");
  assert.equal(last!.last_error, null);
  assert.equal(row.metadata.state, "open");
  assert.equal(row.metadata.number, "5511400000000");
  assert.equal(row.metadata.state_at, NOW.toISOString());
  assert.ok(!JSON.stringify(row.metadata).includes("CHAVE-DA-INSTANCIA"));

  await w.deliver(update("close"));
  row = await loadConnection(sql, w.agencyId, w.result.id);
  const dropped = await one<{ last_error: string | null }>(sql, `select last_error from integration_connections where id = $1`, [w.result.id]);
  assert.equal(row.metadata.state, "close");
  assert.equal(row.status, "active");
  assert.equal(dropped!.last_error, SESSION_DROPPED);

  // Estado de outra instância não mexe nesta conexão.
  await w.deliver({ ...update("open"), instance: "outra" });
  assert.equal((await loadConnection(sql, w.agencyId, w.result.id)).metadata.state, "close");
});

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/** Pedidos pendentes numa conversa da conexão com FROM (como uma execução que espera aprovação). */
async function seedPending(agencyId: string, connectionId: string, count: number): Promise<string[]> {
  const xodo = await seedXodo(sql, agencyId);
  const conv = await one<{ id: string }>(
    sql,
    `insert into xodo_conversations (agency_id, xodo_id, channel, connection_id, external_key, metadata)
     values ($1, $2, 'whatsapp', $3, $4, $5::jsonb) returning id`,
    [agencyId, xodo.id, connectionId, FROM, JSON.stringify({ number: FROM })],
  );
  const run = await one<{ id: string }>(
    sql,
    `insert into xodo_runs (xodo_id, agency_id, trigger, provider, model, status, conversation_id)
     values ($1, $2, 'channel', 'faux', 'faux-1', 'waiting_approval', $3) returning id`,
    [xodo.id, agencyId, conv!.id],
  );
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = await one<{ id: string }>(
      sql,
      `insert into xodo_actions (run_id, xodo_id, agency_id, tool_name, category, tool_call_id, step, call_index, input, input_hash, status)
       values ($1, $2, $3, 'avisar_equipe', 'equipe', $4, 1, $5, '{}'::jsonb, 'h', 'pending') returning id`,
      [run!.id, xodo.id, agencyId, `t${i}`, i],
    );
    ids.push(row!.id);
  }
  return ids;
}

test("envio: texto com apikey, aprovações viram instruções, texto longo separa as instruções e erros são claros", async () => {
  const c = await connect(IP_BASE, { instance: "envio" });
  const a = await access(c.deps, c.agencyId, c.result.id);
  const ctx = { deps: c.deps, access: a, target: { number: FROM }, xodoName: "Pipoca" };
  const [first, , third] = await seedPending(c.agencyId, c.result.id, 3);
  // A fila numera só os desta mensagem (1 e 2); o núcleo conta todos os pendentes da conversa (1 e 3).
  const approvals: OutboundApproval[] = [
    { actionId: first, summary: "avisar a equipe", index: 1 },
    { actionId: third, summary: "pausar a campanha\nVerão", index: 2 },
  ];

  await whatsappQrAdapter.send(ctx, { text: "Preciso de aprovação para:\n1. avisar a equipe\n2. pausar a campanha", approvals });
  const text = c.ev.sends().at(-1)!.text;
  assert.match(text, /^Preciso de aprovação/);
  assert.match(text, /\*aprovar 1\* ou \*negar 1\*: avisar a equipe/);
  assert.match(text, /\*aprovar 3\* ou \*negar 3\*: pausar a campanha Verão/);
  assert.equal(approvalInstructions([]), "");
  assert.equal(approvalInstructions([approvals[1]]), "Responda *aprovar* ou *negar*.");
  assert.match(approvalInstructions([approvals[1]], 2), /^Para decidir.*\n• \*aprovar 2\* ou \*negar 2\*: pausar a campanha Verão$/);

  let before = c.ev.sends().length;
  await whatsappQrAdapter.send(ctx, { text: "x".repeat(4090), approvals: [approvals[0]] });
  assert.deepEqual(c.ev.sends().slice(before).map((s) => (s.text.length > 1000 ? "longo" : s.text)), [
    "longo",
    "Para decidir, responda com o número do pedido:\n• *aprovar 1* ou *negar 1*: avisar a equipe",
  ]);

  // Pedido decidido no app enquanto a mensagem esperava: não vira instrução.
  before = c.ev.sends().length;
  await whatsappQrAdapter.send(ctx, { text: "oi", approvals: [{ actionId: "0b9d2f4e-1c3a-4e5f-8a7b-6c5d4e3f2a1b", summary: "x", index: 1 }] });
  assert.deepEqual(c.ev.sends().slice(before).map((s) => s.text), ["oi"]);
  assert.equal(whatsappQrAdapter.maxChars, 4096);
  assert.equal(toWhatsappText("# Título **forte**"), "*Título forte*");

  await assert.rejects(whatsappQrAdapter.send({ ...ctx, target: {} }, { text: "oi", approvals: [] }), ChannelError);
  await assert.rejects(whatsappQrAdapter.send({ ...ctx, target: { number: "+55 11 9" } }, { text: "oi", approvals: [] }), ChannelError);

  c.ev.s.fail["/message/sendText/"] = () => evoError(400, "Error: Connection Closed");
  await assert.rejects(whatsappQrAdapter.send(ctx, { text: "oi", approvals: [] }), (e: unknown) => e instanceof IntegrationError && e.message === SESSION_DROPPED);
  c.ev.s.fail["/message/sendText/"] = () => evoError(400, { jid: `${FROM}@s.whatsapp.net`, exists: false, number: FROM });
  await assert.rejects(whatsappQrAdapter.send(ctx, { text: "oi", approvals: [] }), /Este número não tem WhatsApp/);

  // 200 que não é da Evolution (proxy, página de login): a entrega falha e a fila tenta de novo.
  c.ev.s.fail["/message/sendText/"] = () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(whatsappQrAdapter.send(ctx, { text: "oi", approvals: [] }), /não respondeu como a Evolution API/);

  // Chave recusada: a conexão fica marcada para reconectar.
  c.ev.s.fail["/message/sendText/"] = () => evoError(401, "Unauthorized");
  await assert.rejects(whatsappQrAdapter.send(ctx, { text: "oi", approvals: [] }), /recusou a chave/);
  assert.equal((await loadConnection(sql, c.agencyId, c.result.id)).status, "expired");
});

test("envio confere o endereço de novo: gateway que passou a apontar para rede interna não recebe nada", async () => {
  const c = await connect(IP_BASE, { instance: "dns" });
  await sql.query(`update integration_connections set metadata = metadata || '{"base_url":"http://10.0.0.7:8080"}'::jsonb where id = $1`, [c.result.id]);
  const a = await access(c.deps, c.agencyId, c.result.id);
  const before = c.ev.calls.length;
  await assert.rejects(
    whatsappQrAdapter.send({ deps: c.deps, access: a, target: { number: FROM }, xodoName: null }, { text: "oi", approvals: [] }),
    /rede privada/,
  );
  assert.equal(c.ev.calls.length, before);
});
