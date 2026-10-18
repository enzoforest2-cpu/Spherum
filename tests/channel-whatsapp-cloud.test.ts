import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ZodError } from "zod";
import { createPairingCode } from "../src/lib/channels/pairing";
import { hmacHex, verifyHubSignature } from "../src/lib/channels/security";
import { ChannelError, type ChannelDeps } from "../src/lib/channels/types";
import {
  createWhatsappCloudConnection,
  handleWhatsappCloud,
  loadWhatsappCloudWebhook,
  ONLY_TEXT,
  parseWhatsappCloud,
  verifyWhatsappChallenge,
  whatsappCloudAdapter,
} from "../src/lib/channels/whatsapp-cloud";
import { IntegrationError } from "../src/lib/integrations/http";
import { metaGraph } from "../src/lib/integrations/oauth-providers";
import { access, loadConnection, readSecret, type IntegrationDeps } from "../src/lib/integrations/store";
import { one, type Sql } from "../src/lib/xodos/db";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const NOW = new Date("2026-10-19T12:00:00Z");
const APP_URL = "https://spherum.com.br";
const GRAPH = metaGraph();
const PNID = "109876543210";
const TOKEN = "EAAG-token-permanente-de-teste-0123456789";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const FROM = "5511987654321";
const UUID = "0b9d2f4e-1c3a-4e5f-8a7b-6c5d4e3f2a1b";

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

const metaError = (status: number, code: number, message: string, details?: string) =>
  new Response(
    JSON.stringify({
      error: { message, type: "OAuthException", code, ...(details ? { error_data: { messaging_product: "whatsapp", details } } : {}), fbtrace_id: "Abc" },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

/** Meta falsa: confirma o número e aceita os envios (ou responde o erro da vez). */
function fakeMeta() {
  let sendError: (() => Response) | null = null;
  const f = fakeFetch((c) => {
    if (c.method === "GET" && c.url === `${GRAPH}/${PNID}?fields=display_phone_number,verified_name`) {
      return { display_phone_number: "+55 11 4000-0000", verified_name: "Agência Teste", id: PNID };
    }
    if (c.method === "POST" && c.url === `${GRAPH}/${PNID}/messages`) {
      if (sendError) return sendError();
      return { messaging_product: "whatsapp", contacts: [{ input: FROM, wa_id: FROM }], messages: [{ id: "wamid.saida" }] };
    }
    return metaError(400, 100, "Unsupported get request.");
  });
  const sends = () => f.calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body) as Record<string, unknown>);
  return { ...f, sends, failWith: (make: (() => Response) | null) => (sendError = make) };
}

let seq = 0;
const ts = (d: Date) => String(Math.floor(d.getTime() / 1000));
const wamid = () => `wamid.HBgN${(seq += 1)}`;
const textMsg = (body: string, at = NOW) => ({ from: FROM, id: wamid(), timestamp: ts(at), type: "text", text: { body } });
const buttonReply = (id: string) => ({
  from: FROM,
  id: wamid(),
  timestamp: ts(NOW),
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id, title: "Aprovar" } },
  context: { from: "551140000000", id: "wamid.pedido" },
});
const imageMsg = () => ({ from: FROM, id: wamid(), timestamp: ts(NOW), type: "image", image: { id: "media-1", mime_type: "image/jpeg" } });

function webhook(messages: unknown[], opts: { phoneNumberId?: string; statuses?: unknown[]; field?: string } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-1",
        changes: [
          {
            field: opts.field ?? "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "551140000000", phone_number_id: opts.phoneNumberId ?? PNID },
              contacts: [{ profile: { name: "Ana" }, wa_id: FROM }],
              messages,
              ...(opts.statuses ? { statuses: opts.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

async function world(opts: { autonomy?: string } = {}) {
  const meta = fakeMeta();
  const { agencyId, ownerId } = await seedAgency(sql);
  const clock = new Clock(new Date(NOW));
  const integrations: IntegrationDeps = { sql, masterKey: MASTER, fetch: meta.fn, appUrl: APP_URL, now: clock.now };
  const created = await createWhatsappCloudConnection(integrations, agencyId, { phone_number_id: PNID, access_token: TOKEN, app_secret: APP_SECRET }, ownerId);
  const xodo = await seedXodo(sql, agencyId, { autonomy: opts.autonomy ?? "pergunta_no_que_importa" });
  await sql.query(`insert into xodo_channels (agency_id, xodo_id, connection_id) values ($1, $2, $3)`, [agencyId, xodo.id, created.id]);
  const hook = (await loadWhatsappCloudWebhook(integrations, created.id))!;
  const deps = (model: FakeModel): ChannelDeps => ({
    ...testDeps(sql, model, clock),
    integrations: { masterKey: MASTER, fetch: meta.fn, appUrl: APP_URL },
  });
  const deliver = (payload: unknown, model = new FakeModel([])) => handleWhatsappCloud(deps(model), { whatsapp_cloud: whatsappCloudAdapter }, hook, payload);
  const pair = async () => {
    const { code } = await createPairingCode(sql, agencyId, ownerId, clock.now());
    return deliver(webhook([textMsg(code)]));
  };
  return { meta, agencyId, ownerId, clock, integrations, created, xodo, hook, deliver, pair };
}

// ---------------------------------------------------------------------------
// Webhook: verificação e leitura
// ---------------------------------------------------------------------------

test("verificação do webhook: só com hub.mode=subscribe e o token da conexão", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  const ok = { "hub.mode": "subscribe", "hub.verify_token": "tok-123", "hub.challenge": "1158201444" };
  assert.equal(verifyWhatsappChallenge(q(ok), "tok-123"), "1158201444");
  assert.equal(verifyWhatsappChallenge(q({ ...ok, "hub.verify_token": "outro" }), "tok-123"), null);
  assert.equal(verifyWhatsappChallenge(q({ ...ok, "hub.mode": "unsubscribe" }), "tok-123"), null);
  assert.equal(verifyWhatsappChallenge(q({ "hub.mode": "subscribe", "hub.challenge": "1" }), "tok-123"), null, "sem token");
  assert.equal(verifyWhatsappChallenge(q(ok), ""), null, "conexão sem token");
  assert.equal(verifyWhatsappChallenge(q({ ...ok, "hub.challenge": "<script>" }), "tok-123"), null, "não ecoa qualquer coisa");
});

test("leitura: texto, botões de aprovação e mídia; status, reações, outros campos e lixo ficam de fora", () => {
  const payload = webhook(
    [
      textMsg("Bom dia"),
      buttonReply(`ap:${UUID.toUpperCase()}:1`),
      { from: FROM, id: "wamid.btn", timestamp: ts(NOW), type: "button", button: { payload: `ap:${UUID}:0`, text: "Negar" } },
      { from: FROM, id: "wamid.outro", timestamp: ts(NOW), type: "interactive", interactive: { type: "button_reply", button_reply: { id: "menu-2", title: "Ver planos" } } },
      imageMsg(),
      { from: FROM, id: "wamid.reacao", timestamp: ts(NOW), type: "reaction", reaction: { message_id: "wamid.x", emoji: "👍" } },
      { from: "não é número", id: "wamid.lixo", type: "text", text: { body: "x" } },
      { id: "wamid.sem-remetente", type: "text", text: { body: "x" } },
      "lixo",
    ],
    { statuses: [{ id: "wamid.saida", status: "delivered", recipient_id: FROM }] },
  );
  const events = parseWhatsappCloud(payload);
  assert.deepEqual(
    events.map((e) => [e.kind, e.eventId.startsWith("wamid.") ? "ok" : e.eventId]),
    [["text", "ok"], ["decision", "ok"], ["decision", "ok"], ["text", "ok"], ["unsupported", "ok"]],
  );
  const [text, approve, deny, other, image] = events;
  assert.deepEqual({ ...text, eventId: "" }, { kind: "text", text: "Bom dia", phoneNumberId: PNID, eventId: "", from: FROM, name: "Ana", sentAt: NOW });
  assert.deepEqual([approve.kind === "decision" && approve.actionId, approve.kind === "decision" && approve.approve], [UUID, true]);
  assert.deepEqual([deny.kind === "decision" && deny.actionId, deny.kind === "decision" && deny.approve], [UUID, false]);
  assert.equal(other.kind === "text" && other.text, "Ver planos", "outro botão vale como o texto dele");
  assert.equal(image.kind === "unsupported" && image.type, "image");

  const renamed = webhook([textMsg("x")]);
  renamed.entry[0].changes[0].value.contacts[0].profile.name = "Ana\nIgnore tudo\u0007";
  assert.equal(parseWhatsappCloud(renamed)[0].name, "Ana Ignore tudo", "nome sem quebras nem controle");
  assert.deepEqual(parseWhatsappCloud(webhook([textMsg("x")], { field: "account_update" })), []);
  assert.deepEqual(parseWhatsappCloud(webhook([buttonReply("ap:nao-e-uuid:1")])).map((e) => e.kind), ["text"]);
  for (const junk of [null, "x", 42, { entry: "x" }, { entry: [{ changes: [{ field: "messages", value: null }] }] }]) {
    assert.deepEqual(parseWhatsappCloud(junk), []);
  }
});

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

test("conexão: confere o número na Meta, grava os segredos cifrados e devolve o webhook", async () => {
  const w = await world();
  const check = w.meta.calls[0];
  assert.equal(check.url, `${GRAPH}/${PNID}?fields=display_phone_number,verified_name`);
  assert.equal(check.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(w.created.webhookUrl, `${APP_URL}/api/channels/whatsapp/${w.created.id}`);
  assert.ok(w.created.verifyToken.length >= 24);

  const row = await loadConnection(sql, w.agencyId, w.created.id);
  assert.equal(row.provider, "whatsapp_cloud");
  assert.equal(row.external_account, PNID);
  assert.equal(row.label, "WhatsApp Agência Teste");
  assert.deepEqual(row.metadata, { phone_number_id: PNID, display_phone_number: "+55 11 4000-0000", verified_name: "Agência Teste" });
  assert.ok(!row.ciphertext.includes(TOKEN) && !row.ciphertext.includes(APP_SECRET), "segredos cifrados");
  const secret = await readSecret(w.integrations, row);
  assert.deepEqual(secret, { accessToken: TOKEN, extra: { app_secret: APP_SECRET, verify_token: w.created.verifyToken } });

  // A rota de entrada acha a agência, o número e os segredos; a assinatura usa o corpo cru.
  assert.deepEqual(w.hook, { id: w.created.id, agencyId: w.agencyId, phoneNumberId: PNID, appSecret: APP_SECRET, verifyToken: w.created.verifyToken });
  const body = JSON.stringify(webhook([textMsg("oi")]));
  assert.equal(verifyHubSignature(w.hook.appSecret, `sha256=${hmacHex(APP_SECRET, body)}`, body), true);
  assert.equal(verifyHubSignature(w.hook.appSecret, `sha256=${hmacHex("outro-segredo", body)}`, body), false);

  // Reconectar o mesmo número mantém a conexão (e o endereço) com um token de verificação novo.
  const again = await createWhatsappCloudConnection(
    w.integrations,
    w.agencyId,
    { phone_number_id: PNID, access_token: TOKEN, app_secret: APP_SECRET, label: "Atendimento" },
    w.ownerId,
  );
  assert.equal(again.id, w.created.id);
  assert.notEqual(again.verifyToken, w.created.verifyToken);
  assert.equal((await loadConnection(sql, w.agencyId, w.created.id)).label, "Atendimento");

  // Conexão desconectada não recebe nada.
  await sql.query(`update integration_connections set status = 'revoked' where id = $1`, [w.created.id]);
  assert.equal(await loadWhatsappCloudWebhook(w.integrations, w.created.id), null);
});

test("conexão: dados inválidos e recusa da Meta não gravam nada", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  const ok = { phone_number_id: PNID, access_token: TOKEN, app_secret: APP_SECRET };
  const deps = (handler: (c: Call) => unknown): IntegrationDeps => ({ sql, masterKey: MASTER, fetch: fakeFetch(handler).fn, appUrl: APP_URL });
  const never = deps(() => {
    throw new Error("não deveria chamar a Meta");
  });
  await assert.rejects(createWhatsappCloudConnection(never, agencyId, { ...ok, phone_number_id: "+55 11 4000-0000" }, ownerId), ZodError);
  await assert.rejects(createWhatsappCloudConnection(never, agencyId, { ...ok, access_token: "curto" }, ownerId), ZodError);
  await assert.rejects(createWhatsappCloudConnection(never, agencyId, { ...ok, app_secret: undefined }, ownerId), ZodError);

  const wrongId = deps(() => metaError(400, 100, "Unsupported get request. Object with ID '109876543210' does not exist"));
  await assert.rejects(createWhatsappCloudConnection(wrongId, agencyId, ok, ownerId), (e: unknown) => {
    assert.ok(e instanceof IntegrationError);
    assert.equal(e.status, 400);
    assert.match(e.message, /Não consegui confirmar o número na Meta.*does not exist.*Confira o ID do número/);
    return true;
  });
  const badToken = deps(() => metaError(401, 190, "Error validating access token: Session has expired"));
  await assert.rejects(createWhatsappCloudConnection(badToken, agencyId, ok, ownerId), /recusou o token/);
  const down = deps(() => new Response("<html>erro</html>", { status: 503 }));
  await assert.rejects(createWhatsappCloudConnection(down, agencyId, ok, ownerId), (e: unknown) => e instanceof IntegrationError && e.status === 502);
  const odd = deps(() => ({ id: PNID }));
  await assert.rejects(createWhatsappCloudConnection(odd, agencyId, ok, ownerId), /não devolveu os dados do número/);

  const count = await one<{ n: number }>(sql, `select count(*)::int as n from integration_connections where agency_id = $1`, [agencyId]);
  assert.equal(count!.n, 0);
});

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

test("envio: texto sem prévia de link e um pedido de aprovação por mensagem com botões", async () => {
  const w = await world();
  const ctx = { deps: w.integrations, access: await access(w.integrations, w.agencyId, w.created.id), target: { to: FROM }, xodoName: "Pipoca" };
  const long = "x".repeat(1500);
  await whatsappCloudAdapter.send(ctx, {
    text: "Preciso de aprovação para:\n1. avisar a equipe\n2. outro",
    approvals: [
      { actionId: UUID, summary: "avisar a equipe", index: 1 },
      { actionId: "1b9d2f4e-1c3a-4e5f-8a7b-6c5d4e3f2a1b", summary: long, index: 2 },
    ],
  });
  const posts = w.meta.calls.filter((c) => c.method === "POST");
  assert.ok(posts.every((c) => c.url === `${GRAPH}/${PNID}/messages` && c.headers.get("authorization") === `Bearer ${TOKEN}`));
  const [text, first, second] = w.meta.sends();
  assert.deepEqual(text, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: FROM,
    type: "text",
    text: { body: "Preciso de aprovação para:\n1. avisar a equipe\n2. outro", preview_url: false },
  });
  assert.deepEqual(first, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: FROM,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "1. avisar a equipe" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `ap:${UUID}:1`, title: "Aprovar" } },
          { type: "reply", reply: { id: `ap:${UUID}:0`, title: "Negar" } },
        ],
      },
    },
  });
  const body = (second.interactive as { body: { text: string } }).body.text;
  assert.equal(Array.from(body).length, 1024, "corpo dos botões cabe no limite");
  assert.ok(body.startsWith("2. x") && body.endsWith("…"));

  // Texto vazio (só os botões) não vira mensagem em branco; pedido único vai sem número.
  await whatsappCloudAdapter.send(ctx, { text: "  ", approvals: [{ actionId: UUID, summary: "avisar a equipe", index: 1 }] });
  assert.equal(w.meta.sends().length, 4);
  assert.deepEqual((w.meta.sends()[3].interactive as { body: unknown }).body, { text: "avisar a equipe" });

  await assert.rejects(whatsappCloudAdapter.send({ ...ctx, target: { chat_id: 42 } }, { text: "oi", approvals: [] }), ChannelError);
});

test("envio: fora da janela de 24 horas vira erro claro; token recusado pede reconexão", async () => {
  const w = await world();
  const ctx = { deps: w.integrations, access: await access(w.integrations, w.agencyId, w.created.id), target: { to: FROM }, xodoName: null };
  w.meta.failWith(() =>
    metaError(400, 131047, "(#131047) Re-engagement message", "Message failed to send because more than 24 hours have passed since the customer last replied to this number."),
  );
  await assert.rejects(whatsappCloudAdapter.send(ctx, { text: "oi", approvals: [] }), (e: unknown) => {
    assert.ok(e instanceof IntegrationError);
    assert.match(e.message, /janela de 24 horas.*precisa escrever de novo/);
    assert.equal(e.reauth, false);
    return true;
  });

  w.meta.failWith(() => metaError(400, 100, "(#100) Invalid parameter", "Parameter 'to' is invalid"));
  await assert.rejects(whatsappCloudAdapter.send(ctx, { text: "oi", approvals: [] }), /A Meta recusou: \(#100\) Invalid parameter \(Parameter 'to' is invalid\) \[código 100\]/);

  w.meta.failWith(() => metaError(401, 190, "Error validating access token: The session has been invalidated"));
  await assert.rejects(whatsappCloudAdapter.send(ctx, { text: "oi", approvals: [] }), (e: unknown) => e instanceof IntegrationError && e.reauth);
  const row = await loadConnection(sql, w.agencyId, w.created.id);
  assert.equal(row.status, "expired");
  await assert.rejects(access(w.integrations, w.agencyId, w.created.id), /Reconecte/);

  // Reconectar volta a conexão ao normal.
  await createWhatsappCloudConnection(w.integrations, w.agencyId, { phone_number_id: PNID, access_token: TOKEN, app_secret: APP_SECRET }, w.ownerId);
  assert.equal((await loadConnection(sql, w.agencyId, w.created.id)).status, "active");
});

// ---------------------------------------------------------------------------
// Conversa pelo webhook
// ---------------------------------------------------------------------------

test("entrada: explica o vínculo, vincula pelo código e conversa respondendo ao número de quem escreveu", async () => {
  const w = await world();
  const [unknown] = await w.deliver(webhook([textMsg("oi")]));
  assert.equal(unknown.status, "unknown_sender");
  assert.match(String((w.meta.sends().at(-1)!.text as { body: string }).body), /gere um código no Spherum/);
  assert.equal(w.meta.sends().at(-1)!.to, FROM);

  assert.equal((await w.pair())[0].status, "paired");
  const identity = await one<{ external_user: string; display_name: string }>(
    sql,
    `select external_user, display_name from channel_identities where agency_id = $1 and provider = 'whatsapp'`,
    [w.agencyId],
  );
  assert.deepEqual(identity, { external_user: FROM, display_name: "Ana" });

  const model = new FakeModel([{ text: "Bom dia, Ana! Ontem foram 10 leads." }]);
  const message = textMsg("Bom dia, como foram os leads?");
  const [started] = await w.deliver(webhook([message]), model);
  assert.equal(started.status, "started");
  assert.deepEqual(w.meta.sends().at(-1), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: FROM,
    type: "text",
    text: { body: "Bom dia, Ana! Ontem foram 10 leads.", preview_url: false },
  });
  assert.match(model.requests[0].system, /pelo WhatsApp/);
  const conversation = await one<{ external_key: string; metadata: unknown; channel: string }>(
    sql,
    `select external_key, metadata, channel from xodo_conversations where connection_id = $1`,
    [w.created.id],
  );
  assert.deepEqual(conversation, { external_key: FROM, metadata: { to: FROM }, channel: "whatsapp" });

  // A Meta reenvia: a mesma wamid não roda de novo.
  assert.equal((await w.deliver(webhook([message]), model))[0].status, "duplicate");
  // Mensagem para outro número do mesmo app não é desta conexão; mensagem velha não tem mais resposta.
  assert.deepEqual(await w.deliver(webhook([textMsg("oi")], { phoneNumberId: "999999999" })), []);
  const old = await w.deliver(webhook([textMsg("oi", new Date(NOW.getTime() - 25 * 3600_000))]));
  assert.deepEqual(old.map((r) => [r.status, r.detail]), [["ignored", "antiga"]]);
});

test("botão de aprovação decide o pedido, o xodó continua e o resultado volta em texto", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "avisar_equipe", input: { titulo: "Atenção", mensagem: "CPL subiu" } }] },
    { text: "Feito, avisei." },
  ]);
  await w.deliver(webhook([textMsg("Avisa a equipe que o CPL subiu")]), model);
  const pending = await one<{ id: string }>(sql, `select id from xodo_actions where status = 'pending' and xodo_id = $1`, [w.xodo.id]);
  const ask = w.meta.sends().slice(-2);
  assert.match(String((ask[0].text as { body: string }).body), /Preciso de aprovação/);
  const buttons = (ask[1].interactive as { action: { buttons: { reply: { id: string } }[] } }).action.buttons;
  assert.deepEqual(buttons.map((b) => b.reply.id), [`ap:${pending!.id}:1`, `ap:${pending!.id}:0`]);

  const tap = buttonReply(`ap:${pending!.id}:1`);
  const [decided] = await w.deliver(webhook([tap]), model);
  assert.equal(decided.status, "decided");
  const action = await one<{ status: string; decided_by: string; decided_via: string }>(
    sql,
    `select status, decided_by, decided_via from xodo_actions where id = $1`,
    [pending!.id],
  );
  assert.deepEqual(action, { status: "executed", decided_by: w.ownerId, decided_via: "whatsapp" });
  assert.deepEqual(w.meta.sends().slice(-2).map((s) => (s.text as { body: string }).body), ["Feito, avisei.", "Aprovado e feito."]);

  // Toque repetido (reenvio da Meta) não decide de novo; toque de quem não está vinculado não decide.
  const before = w.meta.sends().length;
  assert.equal((await w.deliver(webhook([tap]), model))[0].status, "duplicate");
  assert.equal(w.meta.sends().length, before);
  const stranger = { ...buttonReply(`ap:${pending!.id}:0`), from: "5521900000000" };
  const [refused] = await w.deliver(webhook([stranger]), model);
  assert.match(String(refused.detail), /Só quem está vinculado/);
});

test("foto ou áudio: avisa que só entende texto, uma vez por hora e só para quem está vinculado", async () => {
  const w = await world();
  assert.equal((await w.deliver(webhook([imageMsg()])))[0].status, "unknown_sender");
  assert.equal(w.meta.sends().length, 0, "quem não está vinculado não recebe nada");

  await w.pair();
  const sent = () => w.meta.sends().filter((s) => (s.text as { body?: string } | undefined)?.body === ONLY_TEXT).length;
  const results = await w.deliver(webhook([imageMsg(), { from: FROM, id: wamid(), timestamp: ts(NOW), type: "audio", audio: { id: "a1" } }]));
  assert.deepEqual(results.map((r) => [r.status, r.detail]), [["ignored", "image"], ["ignored", "audio"]]);
  assert.equal(sent(), 1);
  w.clock.advance(60 * 60 * 1000);
  await w.deliver(webhook([{ ...imageMsg(), timestamp: ts(w.clock.now()) }]));
  assert.equal(sent(), 2);
});
