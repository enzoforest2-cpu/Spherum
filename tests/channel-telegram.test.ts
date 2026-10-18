import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ZodError } from "zod";
import { createPairingCode } from "../src/lib/channels/pairing";
import {
  approvalKeyboard,
  createTelegramConnection,
  deleteTelegramWebhook,
  handleTelegramUpdate,
  ONLY_TEXT,
  parseTelegramUpdate,
  telegramAdapter,
  telegramHookFor,
} from "../src/lib/channels/telegram";
import { ChannelError, type ChannelDeps, type SendContext } from "../src/lib/channels/types";
import { access, loadConnection, readSecret, revokeConnection, type IntegrationDeps } from "../src/lib/integrations/store";
import { decideAction } from "../src/lib/xodos/actions";
import { one, type Sql } from "../src/lib/xodos/db";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const APP = "https://spherum.com.br";
const NOW = new Date("2026-10-19T12:00:00Z");
const SECRET_PART = "AAH-abcdefghijklmnopqrstuvwxyz_0123";
const UUID_A = "0b7e3a52-6a4c-4c1e-9d55-1f0e2a3b4c5d";
const UUID_B = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

// ---------------------------------------------------------------------------
// Telegram falso (sem rede): responde pelo método da URL e guarda o que recebeu
// ---------------------------------------------------------------------------

type Call = { url: string; method: string; token: string; body: Record<string, unknown> };
type Handler = (body: Record<string, unknown>, call: Call) => unknown;

const tgError = (status: number, description: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ ok: false, error_code: status, description, ...extra }), { status });

function telegramServer() {
  const calls: Call[] = [];
  const on: Record<string, Handler> = {};
  let messageId = 500;
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const m = String(input).match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
    assert.ok(m, `URL inesperada: ${String(input)}`);
    const call: Call = { url: String(input), method: m[2], token: m[1], body: JSON.parse(String(init.body ?? "{}")) };
    calls.push(call);
    const custom = on[call.method];
    const out = custom
      ? custom(call.body, call)
      : call.method === "getMe"
        ? { ok: true, result: { id: Number(call.token.split(":")[0]), is_bot: true, first_name: "Pipoca", username: "pipoca_bot" } }
        : call.method === "sendMessage"
          ? { ok: true, result: { message_id: (messageId += 1), chat: { id: call.body.chat_id, type: "private" }, date: 1, text: call.body.text } }
          : { ok: true, result: true };
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const of = (method: string) => calls.filter((c) => c.method === method).map((c) => c.body);
  return { fn, calls, on, of };
}

let botSeq = 700_000_000;

async function world(opts: { autonomy?: string } = {}) {
  const tg = telegramServer();
  const { agencyId, ownerId } = await seedAgency(sql);
  const clock = new Clock(new Date(NOW));
  const token = `${(botSeq += 1)}:${SECRET_PART}`;
  const integ: IntegrationDeps = { sql, masterKey: MASTER, fetch: tg.fn, appUrl: APP, now: clock.now };
  const { id: connectionId } = await createTelegramConnection(integ, agencyId, { token }, ownerId);
  const xodo = await seedXodo(sql, agencyId, { autonomy: opts.autonomy ?? "pergunta_no_que_importa" });
  await sql.query(`insert into xodo_channels (agency_id, xodo_id, connection_id) values ($1, $2, $3)`, [agencyId, xodo.id, connectionId]);
  const deps = (model = new FakeModel([])): ChannelDeps => ({
    ...testDeps(sql, model, clock),
    integrations: { masterKey: MASTER, fetch: tg.fn, appUrl: APP },
  });
  const hook = { id: connectionId, agencyId };
  let updateId = 1000;
  const next = () => (updateId += 1);
  const from = (id = 42) => ({ id, is_bot: false, first_name: "Ana", last_name: "Souza", language_code: "pt-br" });
  const message = (extra: Record<string, unknown>, userId = 42) => {
    const id = next();
    return { update_id: id, message: { message_id: id, date: 1, chat: { id: userId, type: "private", first_name: "Ana" }, from: from(userId), ...extra } };
  };
  const text = (value: string, userId = 42) => message({ text: value }, userId);
  const tap = (data: string, extra: { userId?: number; keyboard?: unknown[][]; message?: unknown } = {}) => ({
    update_id: next(),
    callback_query: {
      id: `cbq-${updateId}`,
      from: from(extra.userId ?? 42),
      chat_instance: "-123",
      data,
      message:
        "message" in extra
          ? extra.message
          : { message_id: 77, date: 1, chat: { id: 42, type: "private" }, text: "Preciso de aprovação", reply_markup: { inline_keyboard: extra.keyboard ?? [] } },
    },
  });
  const adapters = { telegram: telegramAdapter };
  const run = (update: unknown, model?: FakeModel, d?: ChannelDeps, answerWithinMs?: number) =>
    handleTelegramUpdate(d ?? deps(model), adapters, hook, update, { answerWithinMs });
  const pair = async () => {
    const { code } = await createPairingCode(sql, agencyId, ownerId, clock.now());
    return run(text(`/start ${code}`));
  };
  return { tg, agencyId, ownerId, token, integ, connectionId, xodo, clock, deps, hook, text, message, tap, run, pair };
}

const lastText = (tg: ReturnType<typeof telegramServer>) => tg.of("sendMessage").at(-1)?.text;

// ---------------------------------------------------------------------------
// Leitura dos updates
// ---------------------------------------------------------------------------

test("parseTelegramUpdate: conversa privada com texto, grupos, bots, mídia e botões", () => {
  const ana = { id: 42, is_bot: false, first_name: "Ana", last_name: "Souza" };
  const privateChat = { id: 42, type: "private" };
  assert.deepEqual(parseTelegramUpdate({ update_id: 10, message: { message_id: 1, chat: privateChat, from: ana, text: "/start ABCD2345" } }), {
    kind: "text",
    updateId: "10",
    chatId: 42,
    userId: "42",
    displayName: "Ana Souza",
    text: "/start ABCD2345",
  });
  const onlyUsername = parseTelegramUpdate({ update_id: 11, message: { message_id: 1, chat: privateChat, from: { id: 42, username: "ana_s" }, text: "oi" } });
  assert.equal(onlyUsername?.kind === "text" && onlyUsername.displayName, "ana_s");

  const group = parseTelegramUpdate({ update_id: 12, message: { message_id: 1, chat: { id: -100, type: "supergroup" }, from: ana, text: "oi" } });
  assert.deepEqual(group, { kind: "ignored", updateId: "12", reason: "supergroup" });
  assert.equal(parseTelegramUpdate({ update_id: 13, message: { message_id: 1, chat: { id: -5, type: "group" }, from: ana, text: "oi" } })?.kind, "ignored");
  assert.equal(parseTelegramUpdate({ update_id: 14, channel_post: { message_id: 1, chat: { id: -9, type: "channel" }, text: "oi" } })?.kind, "ignored");
  const bot = parseTelegramUpdate({ update_id: 15, message: { message_id: 1, chat: privateChat, from: { id: 42, is_bot: true, first_name: "B" }, text: "oi" } });
  assert.deepEqual(bot, { kind: "ignored", updateId: "15", reason: "bot" });

  const photo = parseTelegramUpdate({ update_id: 16, message: { message_id: 1, chat: privateChat, from: ana, photo: [{ file_id: "x" }], caption: "olha" } });
  assert.equal(photo?.kind === "unsupported" && photo.type, "photo");
  const service = parseTelegramUpdate({ update_id: 17, message: { message_id: 1, chat: privateChat, from: ana, pinned_message: {} } });
  assert.equal(service?.kind, "ignored");

  const tap = parseTelegramUpdate({
    update_id: 18,
    callback_query: {
      id: "q1",
      from: ana,
      data: `ap:${UUID_A.toUpperCase()}:0`,
      message: {
        message_id: 7,
        chat: privateChat,
        reply_markup: {
          inline_keyboard: [
            [{ text: "Aprovar", callback_data: `ap:${UUID_A}:1`, extra: "x" }, { text: "Abrir", url: "https://x" }],
            [{ text: "Outro", callback_data: "qualquer" }],
          ],
        },
      },
    },
  });
  assert.deepEqual(tap, {
    kind: "callback",
    updateId: "18",
    callbackId: "q1",
    userId: "42",
    decision: { actionId: UUID_A, approve: false },
    chatId: 42,
    messageId: 7,
    keyboard: [[{ text: "Aprovar", callback_data: `ap:${UUID_A}:1` }]],
  });
  const other = parseTelegramUpdate({ update_id: 19, callback_query: { id: "q2", from: ana, data: `ap:${UUID_A}:2` } });
  assert.equal(other?.kind === "callback" && other.decision, null);
  assert.equal(other?.kind === "callback" && other.chatId, null, "sem a mensagem (inline ou inacessível)");

  assert.equal(parseTelegramUpdate({ message: { text: "oi" } }), null);
  assert.equal(parseTelegramUpdate({ update_id: "20" }), null);
  assert.equal(parseTelegramUpdate(null), null);
});

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

test("conexão: confere o token, grava cifrado e aponta o webhook com um segredo", async () => {
  const tg = telegramServer();
  const { agencyId, ownerId } = await seedAgency(sql);
  const integ: IntegrationDeps = { sql, masterKey: MASTER, fetch: tg.fn, appUrl: `${APP}/`, now: () => NOW };
  const token = `${(botSeq += 1)}:${SECRET_PART}`;
  const created = await createTelegramConnection(integ, agencyId, { token: `  ${token} ` }, ownerId);
  assert.deepEqual(created.bot, { id: botSeq, username: "pipoca_bot", name: "Pipoca" });
  assert.deepEqual(tg.calls.map((c) => c.method), ["getMe", "setWebhook"]);
  assert.ok(tg.calls.every((c) => c.token === token));

  const hook = tg.of("setWebhook")[0];
  assert.equal(hook.url, `${APP}/api/channels/telegram/${created.id}`);
  assert.match(String(hook.secret_token), /^[A-Za-z0-9_-]{1,256}$/);
  assert.deepEqual(hook.allowed_updates, ["message", "callback_query"]);
  assert.equal(hook.drop_pending_updates, true);

  const row = await loadConnection(sql, agencyId, created.id);
  assert.equal(row.provider, "telegram");
  assert.equal(row.external_account, String(botSeq));
  assert.equal(row.status, "active");
  assert.equal(row.label, "Telegram @pipoca_bot");
  assert.deepEqual(row.metadata, { bot_id: botSeq, username: "pipoca_bot", name: "Pipoca" });
  assert.ok(!row.ciphertext.includes(token), "o token fica cifrado");
  const secret = await readSecret(integ, row);
  assert.equal(secret.apiKey, token);
  assert.equal(secret.extra?.webhook_secret, hook.secret_token);

  // Só o segredo certo abre a rota; o resto dá o mesmo null.
  assert.deepEqual(await telegramHookFor(integ, created.id, String(hook.secret_token)), { id: created.id, agencyId });
  assert.equal(await telegramHookFor(integ, created.id, "errado"), null);
  assert.equal(await telegramHookFor(integ, created.id, null), null);
  assert.equal(await telegramHookFor(integ, UUID_A, String(hook.secret_token)), null);
  assert.equal(await telegramHookFor(integ, "nao-e-uuid", String(hook.secret_token)), null);

  // Reconectar o mesmo bot reaproveita a conexão e troca o segredo.
  const again = await createTelegramConnection(integ, agencyId, { token, label: "Bot da Pipoca" }, ownerId);
  assert.equal(again.id, created.id);
  const newSecret = String(tg.of("setWebhook")[1].secret_token);
  assert.notEqual(newSecret, hook.secret_token);
  assert.equal(await telegramHookFor(integ, created.id, String(hook.secret_token)), null);
  assert.ok(await telegramHookFor(integ, created.id, newSecret));
  assert.equal((await loadConnection(sql, agencyId, created.id)).label, "Bot da Pipoca");

  // O mesmo bot conectado em outra agência leva o webhook; a conexão antiga fica com erro.
  const other = await seedAgency(sql);
  const moved = await createTelegramConnection(integ, other.agencyId, { token }, other.ownerId);
  assert.notEqual(moved.id, created.id);
  const old = await one<{ status: string; last_error: string }>(sql, `select status, last_error from integration_connections where id = $1`, [created.id]);
  assert.equal(old!.status, "error");
  assert.match(old!.last_error, /conectado de novo em outro lugar/);

  // Desconectar: só apaga o webhook se ele ainda aponta para esta conexão.
  tg.on.getWebhookInfo = () => ({ ok: true, result: { url: `${APP}/api/channels/telegram/${moved.id}`, pending_update_count: 0 } });
  assert.equal(await deleteTelegramWebhook(integ, agencyId, created.id), false);
  assert.equal(tg.of("deleteWebhook").length, 0);
  assert.equal(await deleteTelegramWebhook(integ, other.agencyId, moved.id), true);
  assert.deepEqual(tg.of("deleteWebhook"), [{ drop_pending_updates: true }]);

  await revokeConnection(integ, agencyId, created.id);
  assert.equal(await telegramHookFor(integ, created.id, newSecret), null, "desconectada");
  assert.equal(await deleteTelegramWebhook(integ, agencyId, created.id), false);
});

test("conexão: token inválido, recusado ou webhook recusado viram erros claros sem vazar o token", async () => {
  const tg = telegramServer();
  const { agencyId, ownerId } = await seedAgency(sql);
  const integ: IntegrationDeps = { sql, masterKey: MASTER, fetch: tg.fn, appUrl: APP, now: () => NOW };
  const token = `${(botSeq += 1)}:${SECRET_PART}`;
  const count = async () =>
    Number((await one<{ n: number }>(sql, `select count(*)::int as n from integration_connections where agency_id = $1`, [agencyId]))!.n);

  await assert.rejects(createTelegramConnection(integ, agencyId, { token: "123:curto" }, ownerId), ZodError);
  await assert.rejects(createTelegramConnection(integ, agencyId, {}, ownerId), ZodError);
  assert.equal(tg.calls.length, 0, "formato errado nem chega ao Telegram");

  tg.on.getMe = () => tgError(401, "Unauthorized");
  await assert.rejects(createTelegramConnection(integ, agencyId, { token }, ownerId), (e: Error) => {
    assert.match(e.message, /recusou o token/);
    assert.ok(!e.message.includes(token));
    return true;
  });
  tg.on.getMe = () => tgError(404, "Not Found");
  await assert.rejects(createTelegramConnection(integ, agencyId, { token }, ownerId), /recusou o token/);
  tg.on.getMe = () => ({ ok: true, result: { id: 1, is_bot: true, first_name: "Outro" } });
  await assert.rejects(createTelegramConnection(integ, agencyId, { token }, ownerId), /outro bot/);
  assert.equal(await count(), 0, "nada gravado");

  // Erro de rede com a URL (que leva o token) na mensagem: o token sai antes de virar texto.
  tg.on.getMe = (_body, call) => {
    throw new Error(`request to ${call.url} failed, reason: ECONNRESET`);
  };
  await assert.rejects(createTelegramConnection(integ, agencyId, { token }, ownerId), (e: Error) => {
    assert.match(e.message, /Não consegui falar com o Telegram/);
    assert.ok(!e.message.includes(token), "o token não aparece no erro");
    assert.ok(!e.message.includes(SECRET_PART));
    return true;
  });

  delete tg.on.getMe;
  tg.on.setWebhook = () => tgError(400, "Bad Request: bad webhook: HTTPS url must be provided for webhook");
  await assert.rejects(createTelegramConnection(integ, agencyId, { token }, ownerId), /não aceitou o endereço do webhook: .*HTTPS url/);
  const row = await one<{ status: string; last_error: string }>(sql, `select status, last_error from integration_connections where agency_id = $1`, [agencyId]);
  assert.equal(row!.status, "error");
  assert.match(row!.last_error, /HTTPS url must be provided/);
});

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

test("envio: texto puro sem parse_mode, botões de aprovação e erros do Telegram", async () => {
  const w = await world();
  const ctx = async (target: Record<string, unknown> = { chat_id: 42 }): Promise<SendContext> => ({
    deps: w.integ,
    access: await access(w.integ, w.agencyId, w.connectionId),
    target,
    xodoName: "Pipoca",
  });
  await telegramAdapter.send(await ctx(), { text: "Oi! *Negrito* e [link](https://x.com)", approvals: [] });
  const plain = w.tg.of("sendMessage").at(-1)!;
  assert.deepEqual(plain, {
    chat_id: 42,
    text: "Oi! *Negrito* e [link](https://x.com)",
    link_preview_options: { is_disabled: true },
    disable_web_page_preview: true,
  });
  assert.equal(telegramAdapter.maxChars, 4096);

  await telegramAdapter.send(await ctx(), {
    text: "Preciso de aprovação para:\n1. A\n2. B",
    approvals: [
      { actionId: UUID_A, summary: "A", index: 1 },
      { actionId: UUID_B, summary: "B", index: 2 },
    ],
  });
  const keyboard = (w.tg.of("sendMessage").at(-1)!.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.deepEqual(keyboard, [
    [
      { text: "Aprovar 1", callback_data: `ap:${UUID_A}:1` },
      { text: "Negar 1", callback_data: `ap:${UUID_A}:0` },
    ],
    [
      { text: "Aprovar 2", callback_data: `ap:${UUID_B}:1` },
      { text: "Negar 2", callback_data: `ap:${UUID_B}:0` },
    ],
  ]);
  assert.ok(keyboard.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64));
  assert.deepEqual(
    approvalKeyboard([{ actionId: UUID_A, summary: "A", index: 1 }]).flat().map((b) => b.text),
    ["Aprovar", "Negar"],
  );
  assert.deepEqual(approvalKeyboard([{ actionId: "nao-e-uuid", summary: "A", index: 1 }]), []);

  await telegramAdapter.send(await ctx(), { text: "", approvals: [{ actionId: UUID_A, summary: "A", index: 1 }] });
  assert.equal(lastText(w.tg), "Pedidos de aprovação:");
  const before = w.tg.of("sendMessage").length;
  await telegramAdapter.send(await ctx(), { text: "  ", approvals: [] });
  assert.equal(w.tg.of("sendMessage").length, before, "nada para mandar");

  await assert.rejects(telegramAdapter.send(await ctx({}), { text: "oi", approvals: [] }), ChannelError);

  w.tg.on.sendMessage = () => tgError(400, "Bad Request: chat not found");
  await assert.rejects(telegramAdapter.send(await ctx(), { text: "oi", approvals: [] }), /O Telegram recusou: Bad Request: chat not found/);
  w.tg.on.sendMessage = () => ({ ok: false, error_code: 400, description: "Bad Request: message text is empty" });
  await assert.rejects(telegramAdapter.send(await ctx(), { text: "oi", approvals: [] }), /message text is empty/, "ok:false com 200 também é erro");
  w.tg.on.sendMessage = () => tgError(403, "Forbidden: bot was blocked by the user");
  await assert.rejects(telegramAdapter.send(await ctx(), { text: "oi", approvals: [] }), /bloqueou o bot/);
  w.tg.on.sendMessage = () => tgError(429, "Too Many Requests: retry after 7", { parameters: { retry_after: 7 } });
  await assert.rejects(telegramAdapter.send(await ctx(), { text: "oi", approvals: [] }), /limitou os envios.*7 s/);
  w.tg.on.sendMessage = () => new Response("<html>bad gateway</html>", { status: 502 });
  await assert.rejects(telegramAdapter.send(await ctx(), { text: "oi", approvals: [] }), /instável/);

  // Token revogado no @BotFather: a conexão fica marcada para reconectar.
  w.tg.on.sendMessage = () => tgError(401, "Unauthorized");
  await assert.rejects(telegramAdapter.send(await ctx(), { text: "oi", approvals: [] }), /recusou o token/);
  assert.equal((await loadConnection(sql, w.agencyId, w.connectionId)).status, "expired");
});

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

test("entrada: /start CÓDIGO vincula; texto vira conversa; repetição e grupos ficam de fora", async () => {
  const w = await world();
  // Quem não está vinculado recebe a dica no próprio chat.
  assert.equal((await w.run(w.text("oi", 99))).status, "unknown_sender");
  assert.equal(w.tg.of("sendMessage").at(-1)!.chat_id, 99);
  assert.match(String(lastText(w.tg)), /gere um código no Spherum/);

  assert.equal((await w.pair()).status, "paired");
  assert.match(String(lastText(w.tg)), /vinculada/);
  const identity = await one<{ display_name: string }>(
    sql,
    `select display_name from channel_identities where agency_id = $1 and provider = 'telegram' and external_user = '42'`,
    [w.agencyId],
  );
  assert.equal(identity!.display_name, "Ana Souza");

  const update = w.text("Bom dia");
  const started = await w.run(update, new FakeModel([{ text: "Bom dia, Ana!" }]));
  assert.equal(started.status, "started");
  assert.deepEqual(w.tg.of("sendMessage").at(-1), {
    chat_id: 42,
    text: "Bom dia, Ana!",
    link_preview_options: { is_disabled: true },
    disable_web_page_preview: true,
  });
  const conv = await one<{ external_key: string; metadata: unknown }>(
    sql,
    `select external_key, metadata from xodo_conversations where connection_id = $1`,
    [w.connectionId],
  );
  assert.equal(conv!.external_key, "42");
  assert.deepEqual(conv!.metadata, { chat_id: 42 });

  const sent = w.tg.of("sendMessage").length;
  assert.equal((await w.run(update, new FakeModel([{ text: "de novo" }]))).status, "duplicate");
  const group = { update_id: 99_999, message: { message_id: 1, chat: { id: -100, type: "supergroup" }, from: { id: 42, first_name: "Ana" }, text: "Pipoca?" } };
  assert.deepEqual(await w.run(group), { status: "ignored", detail: "supergroup" });
  assert.equal((await w.run({ nada: true })).status, "ignored");
  assert.equal(w.tg.of("sendMessage").length, sent, "nada respondido");
});

test("entrada: mídia de quem está vinculado recebe 'só texto' no máximo uma vez por hora", async () => {
  const w = await world();
  assert.equal((await w.run(w.message({ sticker: { file_id: "s" } }, 77))).status, "unknown_sender");
  assert.equal(w.tg.of("sendMessage").length, 0, "quem não está vinculado não recebe nada");

  await w.pair();
  const photo = w.message({ photo: [{ file_id: "p" }], caption: "olha isso" });
  assert.deepEqual(await w.run(photo), { status: "ignored", detail: "photo" });
  assert.equal(lastText(w.tg), ONLY_TEXT);
  const sent = w.tg.of("sendMessage").length;
  assert.equal((await w.run(photo)).status, "duplicate");
  await w.run(w.message({ voice: { file_id: "v" } }));
  assert.equal(w.tg.of("sendMessage").length, sent, "uma vez por hora");
  w.clock.advance(60 * 60 * 1000);
  await w.run(w.message({ voice: { file_id: "v" } }));
  assert.equal(w.tg.of("sendMessage").length, sent + 1);
});

// ---------------------------------------------------------------------------
// Botões de aprovação
// ---------------------------------------------------------------------------

async function askApproval(w: Awaited<ReturnType<typeof world>>, model: FakeModel) {
  await w.run(w.text("Avisa a equipe que o CPL subiu"), model);
  const pending = await one<{ id: string }>(sql, `select id from xodo_actions where status = 'pending' and xodo_id = $1 order by created_at desc`, [w.xodo.id]);
  return pending!.id;
}

const avisar = (id: string) => ({ toolCalls: [{ id, name: "avisar_equipe", input: { titulo: "Atenção", mensagem: "CPL subiu" } }] });

test("botões: aprovar pelo Telegram decide, responde o toque e tira os botões", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([avisar("t1"), { text: "Feito, avisei." }]);
  const actionId = await askApproval(w, model);
  const ask = w.tg.of("sendMessage").at(-1)!;
  assert.match(String(ask.text), /Preciso de aprovação/);
  const keyboard = (ask.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
  assert.deepEqual(keyboard, [
    [
      { text: "Aprovar", callback_data: `ap:${actionId}:1` },
      { text: "Negar", callback_data: `ap:${actionId}:0` },
    ],
  ]);

  const update = w.tap(`ap:${actionId}:1`, { keyboard });
  const result = await w.run(update, model);
  assert.equal(result.status, "decided");
  assert.equal(result.detail, "Aprovado e feito.");
  const action = await one<{ status: string; decided_by: string; decided_via: string }>(
    sql,
    `select status, decided_by, decided_via from xodo_actions where id = $1`,
    [actionId],
  );
  assert.deepEqual(action, { status: "executed", decided_by: w.ownerId, decided_via: "telegram" });
  assert.deepEqual(w.tg.of("answerCallbackQuery").at(-1), { callback_query_id: update.callback_query.id, text: "Aprovado e feito." });
  assert.deepEqual(w.tg.of("editMessageReplyMarkup").at(-1), { chat_id: 42, message_id: 77, reply_markup: { inline_keyboard: [] } });
  assert.equal(lastText(w.tg), "Feito, avisei.", "o xodó continua no chat");
  assert.equal((await w.run(update, model)).status, "duplicate");
});

test("botões: quem não está vinculado não decide; falha no aviso não quebra a decisão; só a linha decidida some", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([avisar("t1"), { text: "Negado, não avisei." }]);
  const actionId = await askApproval(w, model);
  const keyboard = [
    [
      { text: "Aprovar 1", callback_data: `ap:${actionId}:1` },
      { text: "Negar 1", callback_data: `ap:${actionId}:0` },
    ],
    [
      { text: "Aprovar 2", callback_data: `ap:${UUID_B}:1` },
      { text: "Negar 2", callback_data: `ap:${UUID_B}:0` },
    ],
  ];

  // Outra conta (não vinculada) toca no botão: nada é decidido e os botões ficam.
  const stranger = await w.run(w.tap(`ap:${actionId}:1`, { userId: 99, keyboard }), model);
  assert.equal(stranger.status, "decided");
  assert.match(String(w.tg.of("answerCallbackQuery").at(-1)!.text), /Só quem está vinculado/);
  assert.equal(w.tg.of("editMessageReplyMarkup").length, 0);
  assert.equal((await one<{ status: string }>(sql, `select status from xodo_actions where id = $1`, [actionId]))!.status, "pending");

  // O aviso e a edição falham; a decisão vale mesmo assim, e nada do token vai para o log.
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  w.tg.on.answerCallbackQuery = () => tgError(400, "Bad Request: query is too old and response timeout expired or query ID is invalid");
  w.tg.on.editMessageReplyMarkup = (_body, call) => {
    throw new Error(`request to ${call.url} failed`);
  };
  try {
    const result = await w.run(w.tap(`ap:${actionId}:0`, { keyboard }), model);
    assert.equal(result.status, "decided");
    assert.equal(result.detail, "Negado.");
  } finally {
    console.warn = warn;
  }
  assert.equal((await one<{ status: string }>(sql, `select status from xodo_actions where id = $1`, [actionId]))!.status, "denied");
  assert.ok(logs.length >= 2, "as falhas são registradas");
  assert.ok(logs.every((line) => !line.includes(w.token) && !line.includes(SECRET_PART)), "sem token no log");
  assert.deepEqual(w.tg.of("editMessageReplyMarkup").at(-1), {
    chat_id: 42,
    message_id: 77,
    reply_markup: { inline_keyboard: [keyboard[1]] },
  });

  // Botão que não é de aprovação só recebe a resposta vazia (para parar o carregando).
  delete w.tg.on.answerCallbackQuery;
  const unknown = w.tap("outra-coisa");
  assert.deepEqual(await w.run(unknown, model), { status: "ignored", detail: "botão desconhecido" });
  assert.deepEqual(w.tg.of("answerCallbackQuery").at(-1), { callback_query_id: unknown.callback_query.id });
});

test("botões: decisão demorada responde 'recebido' na hora e o erro chega como mensagem", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([avisar("t1"), { text: "ok" }]);
  const actionId = await askApproval(w, model);
  // Decidido no app antes do toque.
  await decideAction(w.deps(model), { actionId, agencyId: w.agencyId, userId: w.ownerId, approve: false });

  // Banco lento: a decisão passa do tempo de resposta ao toque.
  const slow: Sql = {
    async query(text, params) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return sql.query(text, params);
    },
    transaction: (fn) => sql.transaction(fn),
  };
  const deps = { ...w.deps(model), sql: slow };
  const update = w.tap(`ap:${actionId}:1`, { keyboard: [[{ text: "Aprovar", callback_data: `ap:${actionId}:1` }]] });
  const result = await w.run(update, model, deps, 5);
  assert.equal(result.status, "decided");
  assert.deepEqual(w.tg.of("answerCallbackQuery"), [{ callback_query_id: update.callback_query.id, text: "Recebido! Aprovando…" }]);
  assert.equal(lastText(w.tg), "Este pedido já foi decidido.");
  assert.equal(w.tg.of("sendMessage").at(-1)!.chat_id, 42);
  assert.deepEqual(w.tg.of("editMessageReplyMarkup").at(-1)!.reply_markup, { inline_keyboard: [] }, "pedido decidido perde os botões");

  // Mensagem inacessível (sem a mensagem no callback): responde, mas não tenta editar.
  const edits = w.tg.of("editMessageReplyMarkup").length;
  await w.run(w.tap(`ap:${actionId}:1`, { message: undefined }), model);
  assert.equal(w.tg.of("editMessageReplyMarkup").length, edits);
});
