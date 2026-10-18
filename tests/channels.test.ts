import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { parseDecision, receiveMessage, routeXodo, seenBefore } from "../src/lib/channels/core";
import { chunkText, cleanupChannels, flushOutbox, MAX_ATTEMPTS } from "../src/lib/channels/outbox";
import { deliverRun, listIdentities, listXodoChannels, removeXodoChannel, setXodoChannel, unlinkIdentity } from "../src/lib/channels/manage";
import { createPairingCode, extractPairingCode } from "../src/lib/channels/pairing";
import { hmacHex, readBody, verifyHubSignature, verifySlackSignature } from "../src/lib/channels/security";
import type { ChannelAdapter, ChannelDeps, InboundMessage, OutboundApproval } from "../src/lib/channels/types";
import { saveConnection } from "../src/lib/integrations/store";
import { decideAction } from "../src/lib/xodos/actions";
import { one, type Sql } from "../src/lib/xodos/db";
import { resumeRun } from "../src/lib/xodos/runner";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const NOW = new Date("2026-10-19T12:00:00Z");
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

type Sent = { target: Record<string, unknown>; text: string; approvals: OutboundApproval[]; xodoName: string | null };
function fakeAdapter(maxChars = 4000, fail = 0) {
  const sent: Sent[] = [];
  let failures = fail;
  const adapter: ChannelAdapter = {
    provider: "telegram",
    maxChars,
    async send(ctx, message) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("telegram fora do ar");
      }
      sent.push({ target: ctx.target, text: message.text, approvals: message.approvals, xodoName: ctx.xodoName });
    },
  };
  return { adapter, sent };
}

async function world(opts: { autonomy?: string; role?: string; xodoName?: string } = {}) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const clock = new Clock(new Date(NOW));
  const connectionId = await saveConnection(
    { sql, masterKey: MASTER, fetch: globalThis.fetch, appUrl: "https://spherum.com.br", now: clock.now },
    { agencyId, provider: "telegram", label: "Bot da agência", account: `bot-${agencyId}`, secret: { apiKey: "123:abc" } },
  );
  const xodo = await seedXodo(sql, agencyId, { autonomy: opts.autonomy ?? "pergunta_no_que_importa", name: opts.xodoName ?? "Pipoca" });
  await sql.query(`insert into xodo_channels (agency_id, xodo_id, connection_id) values ($1, $2, $3)`, [agencyId, xodo.id, connectionId]);
  let userId = ownerId;
  if (opts.role) {
    userId = randomUUID();
    await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, $3)`, [agencyId, userId, opts.role]);
  }
  const fake = fakeAdapter();
  const deps = (model: FakeModel): ChannelDeps => ({
    ...testDeps(sql, model, clock),
    integrations: { masterKey: MASTER, fetch: globalThis.fetch, appUrl: "https://spherum.com.br" },
  });
  let n = 0;
  const msg = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
    provider: "telegram",
    connectionId,
    agencyId,
    eventId: `upd-${(n += 1)}-${randomUUID()}`,
    externalUser: "tg-42",
    displayName: "Ana",
    conversationKey: "chat-42",
    text,
    reply: { chat_id: 42 },
    direct: true,
    ...extra,
  });
  const pair = async (model = new FakeModel([])) => {
    const { code } = await createPairingCode(sql, agencyId, userId, clock.now());
    return receiveMessage(deps(model), { telegram: fake.adapter }, msg(`/start ${code}`));
  };
  return { agencyId, ownerId, userId, connectionId, xodo, clock, fake, deps, msg, pair };
}

// ---------------------------------------------------------------------------
// Verificações e ajudas
// ---------------------------------------------------------------------------

test("assinaturas: Slack com tempo e corpo, X-Hub-Signature-256 da Meta e do GitHub", () => {
  const body = '{"type":"event_callback"}';
  const ts = String(Math.floor(NOW.getTime() / 1000));
  const signature = `v0=${hmacHex("segredo", `v0:${ts}:${body}`)}`;
  assert.equal(verifySlackSignature("segredo", { timestamp: ts, signature }, body, NOW), true);
  assert.equal(verifySlackSignature("segredo", { timestamp: ts, signature }, `${body} `, NOW), false, "corpo alterado");
  assert.equal(verifySlackSignature("outro", { timestamp: ts, signature }, body, NOW), false);
  assert.equal(verifySlackSignature("segredo", { timestamp: ts, signature }, body, new Date(NOW.getTime() + 301_000)), false, "velho demais");
  assert.equal(verifySlackSignature("", { timestamp: ts, signature }, body, NOW), false, "sem segredo configurado");

  const hub = `sha256=${hmacHex("app-secret", body)}`;
  assert.equal(verifyHubSignature("app-secret", hub, body), true);
  assert.equal(verifyHubSignature("app-secret", hub.toUpperCase(), body), false);
  assert.equal(verifyHubSignature("app-secret", null, body), false);
  assert.equal(verifyHubSignature("app-secret", "sha1=abc", body), false);
});

test("corpo grande demais é recusado mesmo sem Content-Length", async () => {
  const big = new Request("https://x", { method: "POST", body: "a".repeat(300_000) });
  big.headers.delete("content-length");
  await assert.rejects(readBody(big), /grande demais/);
  assert.equal(await readBody(new Request("https://x", { method: "POST", body: "oi" })), "oi");
});

test("códigos de pareamento, decisões por texto e divisão de mensagens", () => {
  assert.equal(extractPairingCode("/start ABCD2345"), "ABCD2345");
  assert.equal(extractPairingCode("vincular abcd-2345"), "ABCD2345");
  assert.equal(extractPairingCode("/start@spherum_bot ABCD2345"), "ABCD2345");
  assert.equal(extractPairingCode("ABCD1234"), null, "1 não está no alfabeto");
  assert.equal(extractPairingCode("oi tudo bem"), null);
  assert.deepEqual(parseDecision("Aprovar"), { approve: true, index: null });
  assert.deepEqual(parseDecision("negar 2"), { approve: false, index: 2 });
  assert.deepEqual(parseDecision("Não"), { approve: false, index: null });
  assert.equal(parseDecision("sim, mas muda o texto"), null);
  const chunks = chunkText(`${"a".repeat(30)}\n\n${"b".repeat(30)} ${"c".repeat(80)}`, 50);
  assert.ok(chunks.every((c) => c.length <= 50));
  assert.equal(chunks[0], "a".repeat(30));
  assert.equal(chunks.join("").replace(/\s/g, ""), `${"a".repeat(30)}${"b".repeat(30)}${"c".repeat(80)}`);
});

// ---------------------------------------------------------------------------
// Quem fala com o xodó
// ---------------------------------------------------------------------------

test("quem não está vinculado recebe a explicação uma vez por dia; o código vincula", async () => {
  const w = await world();
  const deps = w.deps(new FakeModel([]));
  const first = await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("oi"));
  const second = await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("oi de novo"));
  assert.deepEqual([first.status, second.status], ["unknown_sender", "unknown_sender"]);
  assert.equal(w.fake.sent.length, 1, "a explicação vai uma vez só");
  assert.match(w.fake.sent[0].text, /gere um código no Spherum/);

  // Em grupo, silêncio.
  await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("oi", { externalUser: "tg-99", direct: false }));
  assert.equal(w.fake.sent.length, 1);

  // Código errado também não abre nada; o certo vincula, uma vez só.
  assert.equal((await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("ZZZZ2222"))).status, "unknown_sender");
  const { code } = await createPairingCode(sql, w.agencyId, w.userId, w.clock.now());
  assert.equal((await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg(code))).status, "paired");
  assert.match(w.fake.sent.at(-1)!.text, /vinculada/);
  const reused = await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg(code, { externalUser: "tg-intruso" }));
  assert.equal(reused.status, "unknown_sender", "código de uso único");
});

test("código de outra agência não vincula; código vencido também não", async () => {
  const a = await world();
  const b = await world();
  const { code } = await createPairingCode(sql, b.agencyId, b.userId, b.clock.now());
  assert.equal((await receiveMessage(a.deps(new FakeModel([])), { telegram: a.fake.adapter }, a.msg(code))).status, "unknown_sender");

  const { code: old } = await createPairingCode(sql, a.agencyId, a.userId, a.clock.now());
  a.clock.advance(11 * 60 * 1000);
  assert.equal((await receiveMessage(a.deps(new FakeModel([])), { telegram: a.fake.adapter }, a.msg(old))).status, "unknown_sender");
});

test("evento repetido é descartado; leitor (viewer) vinculado não conversa", async () => {
  const w = await world({ role: "viewer" });
  await w.pair();
  const deps = w.deps(new FakeModel([{ text: "oi" }]));
  const m = w.msg("Bom dia");
  assert.equal((await receiveMessage(deps, { telegram: w.fake.adapter }, m)).status, "unknown_sender", "viewer não usa xodós");
  assert.equal((await receiveMessage(deps, { telegram: w.fake.adapter }, m)).status, "duplicate");
  assert.equal(await seenBefore(sql, "teste", "x1"), false);
  assert.equal(await seenBefore(sql, "teste", "x1"), true);
});

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

test("conversa pelo canal: resposta entregue com o nome do xodó e histórico separado do app", async () => {
  const w = await world();
  await w.pair();
  const model = new FakeModel([{ text: "Bom dia, Ana! Em que posso ajudar?" }, { text: "Ontem foram 10 leads." }]);
  const deps = w.deps(model);
  const r1 = await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("Bom dia"));
  assert.equal(r1.status, "started");
  assert.equal(w.fake.sent.at(-1)!.text, "Bom dia, Ana! Em que posso ajudar?");
  assert.deepEqual(w.fake.sent.at(-1)!.target, { chat_id: 42 });
  assert.equal(w.fake.sent.at(-1)!.xodoName, "Pipoca");

  // Mensagem do app fica fora da conversa do canal.
  await sql.query(`insert into xodo_messages (xodo_id, agency_id, role, text) values ($1, $2, 'user', 'segredo do app')`, [w.xodo.id, w.agencyId]);
  await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("E os leads?"));
  const history = JSON.stringify(model.requests.at(-1)!.messages);
  assert.ok(history.includes("Bom dia, Ana!"), "lembra da conversa do canal");
  assert.ok(!history.includes("segredo do app"), "não mistura com a conversa do app");
  assert.match(model.requests.at(-1)!.system, /pelo Telegram/);

  const saved = await one<{ author_label: string; conversation_id: string }>(
    sql,
    `select author_label, conversation_id from xodo_messages where run_id = $1 and role = 'user'`,
    [r1.runId],
  );
  assert.equal(saved!.author_label, "Ana pelo Telegram");
  assert.ok(saved!.conversation_id);
  const outbox = await sql.query<{ status: string }>(`select status from channel_outbox where conversation_id = $1`, [saved!.conversation_id]);
  assert.deepEqual(outbox.map((o) => o.status), ["sent", "sent"]);
});

test("pedido de aprovação vira botões; 'aprovar' por texto decide e o xodó continua", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([
    { toolCalls: [{ id: "t2", name: "avisar_equipe", input: { titulo: "Atenção", mensagem: "CPL subiu" } }] },
    { text: "Feito, avisei." },
  ]);
  const deps2 = w.deps(model);
  await receiveMessage(deps2, { telegram: w.fake.adapter }, w.msg("Avisa a equipe que o CPL subiu"));
  const ask = w.fake.sent.at(-1)!;
  assert.match(ask.text, /Preciso de aprovação/);
  assert.equal(ask.approvals.length, 1);
  assert.equal(ask.approvals[0].index, 1);
  const pending = await one<{ id: string }>(sql, `select id from xodo_actions where status = 'pending' and xodo_id = $1`, [w.xodo.id]);
  assert.equal(ask.approvals[0].actionId, pending!.id);

  const decided = await receiveMessage(deps2, { telegram: w.fake.adapter }, w.msg("aprovar"));
  assert.equal(decided.status, "decided");
  const action = await one<{ status: string; decided_by: string; decided_via: string }>(
    sql,
    `select status, decided_by, decided_via from xodo_actions where id = $1`,
    [pending!.id],
  );
  assert.deepEqual(action, { status: "executed", decided_by: w.userId, decided_via: "telegram" });
  assert.equal(w.fake.sent.at(-1)!.text, "Feito, avisei.");
});

test("outro pedido enquanto o xodó trabalha naquela conversa: avisa que está ocupado", async () => {
  const w = await world();
  await w.pair();
  const conv = await one<{ id: string }>(
    sql,
    `insert into xodo_conversations (agency_id, xodo_id, channel, connection_id, external_key) values ($1, $2, 'telegram', $3, 'chat-42') returning id`,
    [w.agencyId, w.xodo.id, w.connectionId],
  );
  await sql.query(
    `insert into xodo_runs (xodo_id, agency_id, trigger, provider, model, conversation_id, heartbeat_at) values ($1, $2, 'channel', 'faux', 'faux-1', $3, $4::timestamptz)`,
    [w.xodo.id, w.agencyId, conv!.id, w.clock.now().toISOString()],
  );
  const r = await receiveMessage(w.deps(new FakeModel([{ text: "x" }])), { telegram: w.fake.adapter }, w.msg("e aí?"));
  assert.equal(r.status, "busy");
  assert.match(w.fake.sent.at(-1)!.text, /ainda está trabalhando/);
});

test("roteamento: chamar pelo nome escolhe o xodó; senão vale o do canal e depois o geral", async () => {
  const w = await world({ xodoName: "Faísca" });
  const zuca = await seedXodo(sql, w.agencyId, { name: "Zuca" });
  const nina = await seedXodo(sql, w.agencyId, { name: "Nina" });
  await sql.query(`insert into xodo_channels (agency_id, xodo_id, connection_id, scope) values ($1, $2, $3, '*'), ($1, $4, $3, 'C-MIDIA')`, [
    w.agencyId,
    zuca.id,
    w.connectionId,
    nina.id,
  ]);
  assert.equal((await routeXodo(sql, w.connectionId, "C-OUTRO", "faisca, como estão os leads?"))!.name, "Faísca");
  assert.equal((await routeXodo(sql, w.connectionId, "C-OUTRO", "Oi Zuca!"))!.name, "Zuca");
  assert.equal((await routeXodo(sql, w.connectionId, "C-MIDIA", "como estão os leads?"))!.name, "Nina");
  assert.equal((await routeXodo(sql, w.connectionId, "C-OUTRO", "como estão os leads?"))!.name, "Faísca", "o geral mais antigo");
  assert.equal((await routeXodo(sql, w.connectionId, "C-OUTRO", "faiscante"))!.name, "Faísca", "sem nome exato, cai no geral");
  await sql.query(`update xodos set status = 'paused' where agency_id = $1`, [w.agencyId]);
  assert.equal(await routeXodo(sql, w.connectionId, "C-OUTRO", "oi"), null);
});

// ---------------------------------------------------------------------------
// Entrega
// ---------------------------------------------------------------------------

test("entrega: tenta de novo com espera e desiste depois de 5 tentativas; divide textos longos", async () => {
  const w = await world();
  const conv = await one<{ id: string }>(
    sql,
    `insert into xodo_conversations (agency_id, xodo_id, channel, connection_id, external_key, metadata) values ($1, $2, 'telegram', $3, 'chat-7', '{"chat_id":7}') returning id`,
    [w.agencyId, w.xodo.id, w.connectionId],
  );
  await sql.query(`insert into channel_outbox (agency_id, conversation_id, text) values ($1, $2, $3)`, [w.agencyId, conv!.id, `${"x".repeat(60)} ${"y".repeat(60)}`]);
  const flaky = fakeAdapter(100, 1);
  const deps = w.deps(new FakeModel([]));
  assert.deepEqual(await flushOutbox(deps, { telegram: flaky.adapter }), { sent: 0, failed: 0 });
  // Antes da espera, nada acontece.
  assert.deepEqual(await flushOutbox(deps, { telegram: flaky.adapter }), { sent: 0, failed: 0 });
  w.clock.advance(2_000);
  assert.deepEqual(await flushOutbox(deps, { telegram: flaky.adapter }), { sent: 1, failed: 0 });
  assert.deepEqual(flaky.sent.map((s) => s.text), ["x".repeat(60), "y".repeat(60)]);

  await sql.query(`insert into channel_outbox (agency_id, conversation_id, text) values ($1, $2, 'nunca chega')`, [w.agencyId, conv!.id]);
  const down = fakeAdapter(100, 99);
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await flushOutbox(deps, { telegram: down.adapter });
    w.clock.advance(61_000);
  }
  const row = await one<{ status: string; attempts: number; error: string }>(
    sql,
    `select status, attempts, error from channel_outbox where text = 'nunca chega' and conversation_id = $1`,
    [conv!.id],
  );
  assert.deepEqual(row, { status: "failed", attempts: MAX_ATTEMPTS, error: "telegram fora do ar" });

  // Entrega presa no meio vira falha; eventos antigos somem.
  await sql.query(
    `insert into channel_outbox (agency_id, conversation_id, text, status, next_attempt_at) values ($1, $2, 'presa', 'sending', $3::timestamptz)`,
    [w.agencyId, conv!.id, new Date(w.clock.now().getTime() - 11 * 60_000).toISOString()],
  );
  assert.equal((await cleanupChannels(sql, w.clock.now())).stuckDeliveries, 1);
});

test("pedido já decidido no app não é pedido de novo no canal", async () => {
  const w = await world();
  const conv = await one<{ id: string }>(
    sql,
    `insert into xodo_conversations (agency_id, xodo_id, channel, connection_id, external_key) values ($1, $2, 'telegram', $3, 'chat-8') returning id`,
    [w.agencyId, w.xodo.id, w.connectionId],
  );
  const run = await one<{ id: string }>(
    sql,
    `insert into xodo_runs (xodo_id, agency_id, trigger, provider, model, conversation_id) values ($1, $2, 'channel', 'faux', 'faux-1', $3) returning id`,
    [w.xodo.id, w.agencyId, conv!.id],
  );
  const action = await one<{ id: string }>(
    sql,
    `insert into xodo_actions (run_id, xodo_id, agency_id, tool_name, category, tool_call_id, step, call_index, input, input_hash, status)
     values ($1, $2, $3, 'avisar_equipe', 'equipe', 'c1', 1, 0, '{}', 'h', 'denied') returning id`,
    [run!.id, w.xodo.id, w.agencyId],
  );
  await sql.query(`insert into channel_outbox (agency_id, conversation_id, text, approvals) values ($1, $2, 'Preciso de aprovação', $3::jsonb)`, [
    w.agencyId,
    conv!.id,
    JSON.stringify([{ action_id: action!.id, summary: "avisar a equipe" }]),
  ]);
  const fake = fakeAdapter();
  await flushOutbox(w.deps(new FakeModel([])), { telegram: fake.adapter }, { conversationId: conv!.id });
  assert.equal(fake.sent.length, 0, "não pede de novo o que já foi decidido");
  const row = await one<{ status: string }>(sql, `select status from channel_outbox where conversation_id = $1`, [conv!.id]);
  assert.equal(row!.status, "sent");
});

// ---------------------------------------------------------------------------
// Gestão
// ---------------------------------------------------------------------------

test("gestão: liga xodó a canal com escopo válido; vínculos visíveis só para a pessoa ou para admins", async () => {
  const w = await world();
  const other = await seedXodo(sql, w.agencyId, { name: "Zuca" });
  // Telegram só aceita "*"; escopo de canal é coisa do Slack.
  await assert.rejects(setXodoChannel(sql, w.agencyId, other.id, { connection_id: w.connectionId, scope: "C0123ABCD" }), /Escopo inválido/);
  const id = await setXodoChannel(sql, w.agencyId, other.id, { connection_id: w.connectionId });
  assert.equal((await listXodoChannels(sql, w.agencyId, other.id)).length, 1);
  // Conexão de outra agência não serve.
  const b = await world();
  await assert.rejects(setXodoChannel(sql, w.agencyId, other.id, { connection_id: b.connectionId }), /não encontrada/);
  // Conexão que não é canal também não.
  const mcp = await saveConnection(
    { sql, masterKey: MASTER, fetch: globalThis.fetch, appUrl: "https://spherum.com.br" },
    { agencyId: w.agencyId, provider: "mcp", label: "MCP", account: "https://mcp.example.com", secret: { apiKey: "" } },
  );
  await assert.rejects(setXodoChannel(sql, w.agencyId, other.id, { connection_id: mcp }), /não é um canal/);
  await removeXodoChannel(sql, w.agencyId, other.id, id);
  assert.equal((await listXodoChannels(sql, w.agencyId, other.id)).length, 0);

  const member = randomUUID();
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [w.agencyId, member]);
  await sql.query(`insert into channel_identities (agency_id, provider, external_user, user_id) values ($1, 'telegram', 'tg-1', $2), ($1, 'slack', 'T:U', $3)`, [
    w.agencyId,
    member,
    w.ownerId,
  ]);
  assert.equal((await listIdentities(sql, w.agencyId, member, "member")).length, 1);
  assert.equal((await listIdentities(sql, w.agencyId, w.ownerId, "owner")).length, 2);
  const mine = (await listIdentities(sql, w.agencyId, w.ownerId, "owner")).find((i) => i.user_id === w.ownerId) as { id: string };
  await assert.rejects(unlinkIdentity(sql, w.agencyId, mine.id, member, "member"), /não encontrado/);
  await unlinkIdentity(sql, w.agencyId, mine.id, w.ownerId, "owner");
});

test("decisão tomada no app entrega a continuação no canal", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "avisar_equipe", input: { titulo: "Oi" } }] },
    { text: "Avisei pelo app." },
  ]);
  const deps = w.deps(model);
  const started = await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("Avisa a equipe"));
  const pending = await one<{ id: string }>(sql, `select id from xodo_actions where run_id = $1 and status = 'pending'`, [started.runId]);
  const result = await decideAction(deps, { actionId: pending!.id, agencyId: w.agencyId, userId: w.ownerId, approve: true });
  await resumeRun(deps, result.runId);
  await deliverRun(deps, { telegram: w.fake.adapter }, result.runId);
  assert.equal(w.fake.sent.at(-1)!.text, "Avisei pelo app.");
  const via = await one<{ decided_via: string }>(sql, `select decided_via from xodo_actions where id = $1`, [pending!.id]);
  assert.equal(via!.decided_via, "app");
});

test("numeração única: com dois pedidos abertos na conversa, o segundo é o 2 nos botões, no texto e no 'aprovar 2'", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const deps = w.deps(
    new FakeModel([
      { toolCalls: [{ id: "a1", name: "avisar_equipe", input: { titulo: "Primeiro" } }] },
      { toolCalls: [{ id: "a2", name: "avisar_equipe", input: { titulo: "Segundo" } }] },
      { text: "Mandei o segundo aviso." },
    ]),
  );
  await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("Avisa: primeiro"));
  // A primeira execução espera aprovação; uma nova mensagem abre outra execução na mesma conversa.
  await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("Avisa: segundo"));
  const ask = w.fake.sent.at(-1)!;
  assert.deepEqual(ask.approvals.map((a) => a.index), [2]);
  assert.match(ask.text, /^Preciso de aprovação para:\n2\. avisar a equipe: Segundo$/);

  assert.equal((await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("aprovar"))).detail, "ambíguo");
  await receiveMessage(deps, { telegram: w.fake.adapter }, w.msg("aprovar 2"));
  const statuses = await sql.query<{ status: string; input: { titulo: string } }>(
    `select status, input from xodo_actions where xodo_id = $1 order by created_at`,
    [w.xodo.id],
  );
  assert.deepEqual(statuses.map((s) => [s.input.titulo, s.status]), [["Primeiro", "pending"], ["Segundo", "executed"]]);
});

test("quem já está vinculado pode se vincular de novo com um código (outra pessoa da equipe)", async () => {
  const w = await world();
  await w.pair();
  const colleague = randomUUID();
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [w.agencyId, colleague]);
  const { code } = await createPairingCode(sql, w.agencyId, colleague, w.clock.now());
  const r = await receiveMessage(w.deps(new FakeModel([])), { telegram: w.fake.adapter }, w.msg(`/start ${code}`));
  assert.equal(r.status, "paired");
  const link = await one<{ user_id: string }>(sql, `select user_id from channel_identities where agency_id = $1 and external_user = 'tg-42'`, [w.agencyId]);
  assert.equal(link!.user_id, colleague);
});
