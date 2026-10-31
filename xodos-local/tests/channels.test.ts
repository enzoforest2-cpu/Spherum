import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { before, test } from "node:test";
import { one, type Sql } from "../src/xodos/db";
import { notify } from "../src/xodos/budget";
import { Channels, sameWhatsNumber, splitParts } from "../server/channels";
import { Worker } from "../server/worker";
import type { Ctx } from "../server/api";
import { createTestDb, FakeModel, seedAgency, seedFx, seedXodo, testDeps } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
  await seedFx(sql);
});

type Call = { url: string; body: Record<string, unknown> };

/** Telegram e Meta de mentira: respondem o básico e guardam o que o app mandou. */
function fakeNet() {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (url.endsWith("/getMe")) return ok({ id: 777, username: "pipoca_bot", first_name: "Pipoca" });
    if (url.includes("api.telegram.org")) return ok(url.endsWith("/sendMessage") ? { message_id: calls.length } : true);
    if (url.includes("graph.facebook.com") && url.includes("fields=")) {
      return new Response(JSON.stringify({ display_phone_number: "+1 555 0100", verified_name: "Xodós" }), { status: 200 });
    }
    if (url.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  const sent = (method: string) => calls.filter((c) => c.url.endsWith(`/${method}`));
  return { calls, fetch, sent };
}

async function setup(script: ConstructorParameters<typeof FakeModel>[0], xodoOverrides = {}) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, xodoOverrides);
  const net = fakeNet();
  const model = new FakeModel(script);
  const deps = { ...testDeps(sql, model), integrations: { masterKey: randomBytes(48).toString("base64"), fetch: net.fetch, appUrl: "http://127.0.0.1:4747" } };
  const worker = new Worker(deps);
  const ctx = { deps, worker, state: { ownerId: agencyId, userId: ownerId, masterKey: "", dataDir: "", settings: { nome: "Enzo", pasta: "" } } } as unknown as Ctx;
  const channels = new Channels(ctx);
  ctx.channels = channels;
  return { agencyId, ownerId, xodo, net, model, deps, worker, channels };
}

const conn = (id: string) => one<Record<string, unknown>>(sql, `select * from integration_connections where id = $1`, [id]);
const lastRun = (xodoId: string) => one<{ id: string; status: string; trigger: string }>(sql, `select id, status, trigger from xodo_runs where xodo_id = $1 order by started_at desc limit 1`, [xodoId]);

/** Uma mensagem do Telegram chegando (o mesmo caminho do long polling). */
async function telegramSays(channels: Channels, connectionId: string, text: string, from = 42) {
  const row = await conn(connectionId);
  await (channels as unknown as { onTelegram: (c: unknown, t: string, u: unknown) => Promise<void> }).onTelegram(row, "tok", {
    update_id: Math.floor(Math.random() * 1e6),
    message: { message_id: 1, text, from: { id: from, first_name: "Enzo" }, chat: { id: from, type: "private" } },
  });
}

test("Telegram: só atende quem vinculou pelo código e responde pela fila", async () => {
  const s = await setup([{ text: "Oi, Enzo! Tudo certo por aqui." }]);
  const { id, codigo, link } = await s.channels.connectTelegram({ token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", xodo_id: s.xodo.id });
  assert.match(codigo, /^[A-Z2-9]{8}$/);
  assert.equal(link, `https://t.me/pipoca_bot?start=${codigo}`);

  await telegramSays(s.channels, id, "oi");
  assert.match(String(s.net.sent("sendMessage").at(-1)?.body.text), /xodó particular/);
  assert.equal(await lastRun(s.xodo.id), null);

  await telegramSays(s.channels, id, `/start ${codigo}`);
  assert.match(String(s.net.sent("sendMessage").at(-1)?.body.text), /Pronto, Enzo/);
  // O código é de uso único.
  assert.equal(await one(sql, `select 1 from channel_pairing_codes where agency_id = $1`, [s.agencyId]), null);

  await telegramSays(s.channels, id, "Bom dia!");
  const run = await lastRun(s.xodo.id);
  assert.equal(run?.trigger, "channel");
  await s.worker.drive(run!.id);
  await s.channels.pump();
  const reply = s.net.sent("sendMessage").at(-1)!;
  assert.equal(reply.body.chat_id, "42");
  assert.equal(reply.body.text, "Oi, Enzo! Tudo certo por aqui.");
  const listed = await s.channels.list();
  assert.equal(listed[0].vinculado, "Enzo");
  assert.equal(listed[0].xodo_id, s.xodo.id);
});

test("Telegram: pedido de aprovação vira botão, e o botão decide", async () => {
  const s = await setup(
    [{ toolCalls: [{ id: "c1", name: "me_avisar", input: { titulo: "Lembrete", mensagem: "Beber água" } }] }, { text: "Avisei!" }],
    { autonomy: "sempre_pergunta" },
  );
  const { id, codigo } = await s.channels.connectTelegram({ token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", xodo_id: s.xodo.id });
  await telegramSays(s.channels, id, codigo);
  await telegramSays(s.channels, id, "Me lembra de beber água");
  const run = await lastRun(s.xodo.id);
  await s.worker.drive(run!.id);
  assert.equal((await lastRun(s.xodo.id))?.status, "waiting_approval");
  await s.channels.pump();

  const ask = s.net.sent("sendMessage").at(-1)!;
  assert.match(String(ask.body.text), /Preciso de aprovação/);
  const button = (ask.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0][0];
  assert.match(button.text, /Pode \(1\)/);

  const row = await conn(id);
  await (s.channels as unknown as { onTelegram: (c: unknown, t: string, u: unknown) => Promise<void> }).onTelegram(row, "tok", {
    update_id: 9,
    callback_query: { id: "q1", data: button.callback_data, from: { id: 42 }, message: { message_id: 5, chat: { id: 42 } } },
  });
  const action = await one<{ status: string; decided_via: string }>(sql, `select status, decided_via from xodo_actions where run_id = $1`, [run!.id]);
  assert.equal(action?.decided_via, "telegram");
  assert.ok(["approved", "executed"].includes(action!.status));
  assert.equal(s.net.sent("answerCallbackQuery").at(-1)?.body.text, "Aprovado. Sigo daqui.");
});

test("Telegram: botão de outra pessoa não decide nada", async () => {
  const s = await setup([{ toolCalls: [{ id: "c1", name: "me_avisar", input: { titulo: "x" } }] }], { autonomy: "sempre_pergunta" });
  const { id, codigo } = await s.channels.connectTelegram({ token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", xodo_id: s.xodo.id });
  await telegramSays(s.channels, id, codigo);
  await telegramSays(s.channels, id, "faz aí");
  const run = await lastRun(s.xodo.id);
  await s.worker.drive(run!.id);
  const action = await one<{ id: string }>(sql, `select id from xodo_actions where run_id = $1`, [run!.id]);
  await (s.channels as unknown as { onTelegram: (c: unknown, t: string, u: unknown) => Promise<void> }).onTelegram(await conn(id), "tok", {
    update_id: 10,
    callback_query: { id: "q2", data: `ok:${action!.id}`, from: { id: 99 } },
  });
  assert.equal((await one<{ status: string }>(sql, `select status from xodo_actions where id = $1`, [action!.id]))?.status, "pending");
  assert.match(String(s.net.sent("answerCallbackQuery").at(-1)?.body.text), /não vinculou/);
});

test("avisos do sino também vão para o canal, uma vez só", async () => {
  const s = await setup([]);
  const { id, codigo } = await s.channels.connectTelegram({ token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", xodo_id: s.xodo.id });
  await telegramSays(s.channels, id, codigo);
  await notify(sql, s.agencyId, { kind: "xodo_message", title: "Pipoca: Reunião às 15h", body: "Não esquece." });
  await s.channels.pump();
  await s.channels.pump();
  const notices = s.net.sent("sendMessage").filter((c) => String(c.body.text).startsWith("🔔"));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].body.text, "🔔 Pipoca: Reunião às 15h\n\nNão esquece.");

  await s.channels.update(id, { avisos: false });
  await notify(sql, s.agencyId, { kind: "xodo_message", title: "Outro" });
  await s.channels.pump();
  assert.equal(s.net.sent("sendMessage").filter((c) => String(c.body.text).startsWith("🔔")).length, 1);
});

test("WhatsApp: webhook só vale com a assinatura da Meta e o número cadastrado", async () => {
  const s = await setup([{ text: "Oi pelo WhatsApp!" }]);
  const { id } = await s.channels.connectWhatsapp({
    phone_number_id: "1234567890",
    token: "EAAG-token-de-teste-bem-comprido",
    app_secret: "segredo-do-app",
    meu_numero: "+55 (41) 99999-8888",
    xodo_id: s.xodo.id,
  });
  const listed = (await s.channels.list()).find((c) => c.id === id)!;
  assert.equal(listed.meu_numero, "5541999998888");
  assert.equal(await s.channels.whatsappVerify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "errado", "hub.challenge": "x" })), null);
  assert.equal(await s.channels.whatsappVerify(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": String(listed.verify_token), "hub.challenge": "abc" })), "abc");

  const hook = (from: string, text: string, msgId: string) =>
    Buffer.from(
      JSON.stringify({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, contacts: [{ wa_id: from, profile: { name: "Enzo" } }], messages: [{ id: msgId, from, type: "text", text: { body: text } }] } }] }],
      }),
    );
  const sign = (raw: Buffer) => "sha256=" + createHmac("sha256", "segredo-do-app").update(raw).digest("hex");

  const raw = hook("554199998888", "Bom dia", "m1"); // a Meta manda sem o 9
  assert.equal(await s.channels.whatsappWebhook(raw, "sha256=" + "0".repeat(64)), 401);
  assert.equal(await lastRun(s.xodo.id), null);

  assert.equal(await s.channels.whatsappWebhook(raw, sign(raw)), 200);
  // A Meta reenvia: o mesmo evento não vira dois pedidos.
  assert.equal(await s.channels.whatsappWebhook(raw, sign(raw)), 200);
  const runs = await sql.query(`select id from xodo_runs where xodo_id = $1`, [s.xodo.id]);
  assert.equal(runs.length, 1);

  await s.worker.drive((await lastRun(s.xodo.id))!.id);
  await s.channels.pump();
  const out = s.net.calls.filter((c) => c.url.endsWith("/1234567890/messages")).at(-1)!;
  assert.deepEqual(out.body, { messaging_product: "whatsapp", to: "554199998888", type: "text", text: { body: "Oi pelo WhatsApp!" } });

  // Número que não é o seu: não vira conversa com o xodó.
  const stranger = hook("5511988887777", "oi", "m2");
  await s.channels.whatsappWebhook(stranger, sign(stranger));
  assert.equal((await sql.query(`select id from xodo_runs where xodo_id = $1`, [s.xodo.id])).length, 1);
});

test("números do WhatsApp com e sem o 9, e mensagens longas em pedaços", () => {
  assert.ok(sameWhatsNumber("+55 41 99999-8888", "554199998888"));
  assert.ok(!sameWhatsNumber("5541999998888", "5541999998887"));
  const parts = splitParts(("parágrafo ".repeat(300) + "\n\n").repeat(3), 3800);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3800));
});
