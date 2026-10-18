import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createPairingCode, linkIdentity } from "../src/lib/channels/pairing";
import { hmacHex } from "../src/lib/channels/security";
import {
  fromSlackText,
  handleSlackEvent,
  handleSlackInteraction,
  parseInteractionBody,
  parseSlackEvent,
  readSlackRequest,
  slackAdapter,
  slackBlocks,
  slackConnectionForTeam,
  toMrkdwn,
} from "../src/lib/channels/slack";
import type { ChannelDeps } from "../src/lib/channels/types";
import { SLACK_BOT_SCOPES } from "../src/lib/integrations/oauth-providers";
import { access, saveConnection, type IntegrationDeps } from "../src/lib/integrations/store";
import { one, type Sql } from "../src/lib/xodos/db";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const NOW = new Date("2026-10-19T12:00:00Z");
const BOT = "U0BOT";
const ADAPTERS = { slack: slackAdapter };
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const rand = () => randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

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

/** Slack falso: postMessage, users.info e o response_url dos botões. */
function slackApi() {
  let postReply: unknown = { ok: true, ts: "1760000000.900000", channel: "C0X" };
  const f = fakeFetch((c) => {
    if (c.url.startsWith("https://hooks.slack.com/")) return new Response("ok", { status: 200 });
    if (c.url.endsWith("/chat.postMessage")) return postReply;
    if (c.url.includes("/users.info")) return { ok: true, user: { name: "ana", profile: { display_name: "Ana", real_name: "Ana Lima" } } };
    return { ok: false, error: "unknown_method" };
  });
  const posts = () => f.calls.filter((c) => c.url.endsWith("/chat.postMessage")).map((c) => JSON.parse(c.body) as Record<string, unknown>);
  const hooks = () => f.calls.filter((c) => c.url.startsWith("https://hooks.slack.com/")).map((c) => JSON.parse(c.body) as Record<string, unknown>);
  return { f, posts, hooks, failPosts: (reply: unknown) => (postReply = reply) };
}

async function world(o: { team?: string; scopes?: string[]; autonomy?: string; channel?: boolean } = {}) {
  const team = o.team ?? `T${rand()}`;
  const { agencyId, ownerId } = await seedAgency(sql);
  const clock = new Clock(new Date(NOW));
  const api = slackApi();
  const idep: IntegrationDeps = { sql, masterKey: MASTER, fetch: api.f.fn, appUrl: "https://spherum.com.br", now: clock.now };
  const connectionId = await saveConnection(idep, {
    agencyId,
    provider: "slack",
    label: "Slack da agência",
    account: team,
    scopes: o.scopes ?? [...SLACK_BOT_SCOPES],
    secret: { accessToken: "xoxb-teste" },
    metadata: { team_id: team, bot_user_id: BOT, app_id: "A0SPHERUM" },
  });
  const xodo = await seedXodo(sql, agencyId, { autonomy: o.autonomy ?? "pergunta_no_que_importa" });
  if (o.channel !== false) {
    await sql.query(`insert into xodo_channels (agency_id, xodo_id, connection_id) values ($1, $2, $3)`, [agencyId, xodo.id, connectionId]);
  }
  const deps = (model = new FakeModel([])): ChannelDeps => ({
    ...testDeps(sql, model, clock),
    integrations: { masterKey: MASTER, fetch: api.f.fn, appUrl: "https://spherum.com.br" },
  });
  let n = 0;
  const envelope = (event: Record<string, unknown>, eventId = `Ev${rand()}`) => ({
    token: "ignorado",
    type: "event_callback",
    team_id: team,
    api_app_id: "A0SPHERUM",
    event_id: eventId,
    event_time: 1760000000,
    event: { team, ts: `1760000000.${String((n += 1)).padStart(6, "0")}`, ...event },
  });
  const dm = (text: string, user = "U0ANA") => envelope({ type: "message", channel_type: "im", channel: `D${user.slice(1)}`, user, text });
  const mention = (text: string, extra: Record<string, unknown> = {}) =>
    envelope({ type: "app_mention", channel: "C0MIDIA", user: "U0ANA", text: `<@${BOT}> ${text}`, ...extra });
  const send = (body: unknown, model = new FakeModel([])) => handleSlackEvent(deps(model), ADAPTERS, parseSlackEvent(body));
  const pair = async () => {
    const { code } = await createPairingCode(sql, agencyId, ownerId, clock.now());
    return send(dm(code));
  };
  return { team, agencyId, ownerId, connectionId, xodo, clock, api, idep, deps, envelope, dm, mention, send, pair };
}

// ---------------------------------------------------------------------------
// Assinatura e tradução
// ---------------------------------------------------------------------------

function signed(body: string, secret: string, ts = Math.floor(NOW.getTime() / 1000)) {
  return new Request("https://spherum.com.br/api/channels/slack/events", {
    method: "POST",
    body,
    headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${hmacHex(secret, `v0:${ts}:${body}`)}` },
  });
}

test("assinatura: confere o corpo cru; sem segredo, 503; assinatura errada ou velha, 401", async () => {
  const body = '{"type":"url_verification","challenge":"abc"}';
  assert.equal(await readSlackRequest(signed(body, "segredo"), "segredo", NOW), body);
  await assert.rejects(readSlackRequest(signed(body, "segredo"), undefined, NOW), (e: { status: number; message: string }) => {
    assert.equal(e.status, 503);
    assert.match(e.message, /SLACK_SIGNING_SECRET/);
    return true;
  });
  await assert.rejects(readSlackRequest(signed(body, "outro"), "segredo", NOW), (e: { status: number }) => e.status === 401);
  const old = signed(body, "segredo", Math.floor(NOW.getTime() / 1000) - 600);
  await assert.rejects(readSlackRequest(old, "segredo", NOW), (e: { status: number }) => e.status === 401);
  const unsigned = new Request("https://x", { method: "POST", body });
  await assert.rejects(readSlackRequest(unsigned, "segredo", NOW), (e: { status: number }) => e.status === 401);

  const form = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions" }))}`;
  assert.deepEqual(parseInteractionBody(form), { type: "block_actions" });
  assert.throws(() => parseInteractionBody("x=1"), /sem payload/);
  assert.throws(() => parseInteractionBody("payload=%7Bnope"), /inválido/);
});

test("Events API: verificação da URL, menção, thread, mensagem direta e mensagem de canal", () => {
  assert.deepEqual(parseSlackEvent({ type: "url_verification", challenge: "3eZbrw1aB", token: "x" }), {
    kind: "url_verification",
    challenge: "3eZbrw1aB",
  });
  const base = { type: "event_callback", team_id: "T0AG", event_id: "Ev1" };
  const m = parseSlackEvent({ ...base, event: { type: "app_mention", user: "U1", text: "<@U0BOT> oi", ts: "1.000100", channel: "C1", team: "T0AG" } });
  assert.deepEqual(m, {
    kind: "mention",
    eventId: "Ev1",
    teamId: "T0AG",
    userTeam: "T0AG",
    channel: "C1",
    user: "U1",
    text: "<@U0BOT> oi",
    ts: "1.000100",
    threadTs: null,
  });
  const inThread = parseSlackEvent({ ...base, event: { type: "app_mention", user: "U1", text: "x", ts: "2.0", thread_ts: "1.000100", channel: "C1" } });
  assert.equal(inThread.kind === "mention" && inThread.threadTs, "1.000100");
  const direct = parseSlackEvent({ ...base, event: { type: "message", channel_type: "im", user: "U1", text: "oi", ts: "1.0", channel: "D1" } });
  assert.equal(direct.kind, "direct");
  for (const channel_type of ["channel", "group"]) {
    assert.equal(parseSlackEvent({ ...base, event: { type: "message", channel_type, user: "U1", text: "oi", ts: "1.0", channel: "C1" } }).kind, "channel");
  }
  const broadcast = { type: "message", subtype: "thread_broadcast", channel_type: "channel", user: "U1", text: "oi", ts: "1.0", channel: "C1" };
  assert.equal(parseSlackEvent({ ...base, event: broadcast }).kind, "channel", "resposta mandada também ao canal é de pessoa");

  const ignored = [
    { type: "message", channel_type: "im", bot_id: "B1", user: "U1", text: "oi", ts: "1.0", channel: "D1" },
    { type: "message", subtype: "bot_message", channel_type: "im", text: "oi", ts: "1.0", channel: "D1" },
    { type: "message", subtype: "message_changed", channel_type: "im", user: "U1", ts: "1.0", channel: "D1" },
    { type: "message", subtype: "message_deleted", channel_type: "channel", ts: "1.0", channel: "C1" },
    { type: "message", subtype: "channel_join", channel_type: "channel", user: "U1", text: "entrou", ts: "1.0", channel: "C1" },
    { type: "message", channel_type: "mpim", user: "U1", text: "oi", ts: "1.0", channel: "G1" },
    { type: "app_mention", user: "U1", text: "<@U0BOT> oi", ts: "1.0", channel: "D1" },
    { type: "reaction_added", user: "U1", reaction: "eyes" },
    { type: "message", channel_type: "im", user: "u-minúsculo", text: "oi", ts: "1.0", channel: "D1" },
  ];
  for (const event of ignored) assert.equal(parseSlackEvent({ ...base, event }).kind, "ignored", JSON.stringify(event));
  assert.equal(parseSlackEvent({ type: "event_callback", event: { type: "app_mention" } }).kind, "ignored", "sem workspace e id");
  assert.equal(parseSlackEvent({ type: "app_rate_limited", team_id: "T0AG" }).kind, "ignored");
  assert.equal(parseSlackEvent("texto").kind, "ignored");
  assert.equal(parseSlackEvent(null).kind, "ignored");
});

test("texto: o que vem do Slack fica legível; o que vai é escapado e vira mrkdwn", () => {
  assert.equal(
    fromSlackText(`<@${BOT}> veja <https://x.com/a?b=1&amp;c=2|o relatório> em <#C1|midia> &lt;urgente&gt; <@${BOT}|bot>`, BOT),
    "veja o relatório (https://x.com/a?b=1&c=2) em #midia <urgente>",
  );
  assert.equal(fromSlackText("<@U2> e <https://x.com>", BOT), "<@U2> e https://x.com", "outras menções ficam");
  assert.equal(fromSlackText("em <#C0MIDIA|> e <#C0GERAL>", BOT), "em #C0MIDIA e #C0GERAL", "canal sem nome fica com o id");
  assert.equal(
    toMrkdwn("## Resumo\n**CPL** subiu & <!channel> veja [o painel](https://x.com/p?a=1&b=2)"),
    "*Resumo*\n*CPL* subiu &amp; &lt;!channel&gt; veja <https://x.com/p?a=1&amp;b=2|o painel>",
  );
});

test("conexão do workspace: com duas agências no mesmo Slack, código, vínculo e xodó do canal decidem; revogada não conta", async () => {
  const team = `T${rand()}`;
  const withXodo = await world({ team });
  const without = await world({ team, channel: false });
  // A sem xodó foi atualizada por último, mas não tem quem responda.
  await sql.query(`update integration_connections set updated_at = now() + interval '1 hour' where id = $1`, [without.connectionId]);
  const conn = await slackConnectionForTeam(sql, team);
  assert.deepEqual(
    { id: conn!.id, agencyId: conn!.agencyId, teamId: conn!.teamId, bot: conn!.botUserId },
    { id: withXodo.connectionId, agencyId: withXodo.agencyId, teamId: team, bot: BOT },
  );

  // A outra agência (o cliente) escolhe um xodó só para o canal dela: as menções ali são dela.
  await sql.query(`insert into xodo_channels (agency_id, xodo_id, connection_id, scope) values ($1, $2, $3, 'C0CLIENTE')`, [
    without.agencyId,
    without.xodo.id,
    without.connectionId,
  ]);
  const cliente = without;
  assert.equal((await slackConnectionForTeam(sql, team, { channel: "C0CLIENTE" }))!.id, cliente.connectionId);
  assert.equal((await slackConnectionForTeam(sql, team, { channel: "C0MIDIA" }))!.id, withXodo.connectionId);
  // Quem já está vinculado a uma agência fala com ela; o código de pareamento leva à agência que o gerou.
  await linkIdentity(sql, { agencyId: cliente.agencyId, provider: "slack", externalUser: `${team}:U0BIA`, userId: cliente.ownerId });
  assert.equal((await slackConnectionForTeam(sql, team, { user: "U0BIA" }))!.id, cliente.connectionId);
  const { code } = await createPairingCode(sql, cliente.agencyId, cliente.ownerId, NOW);
  assert.equal((await slackConnectionForTeam(sql, team, { user: "U0NOVO", code }))!.id, cliente.connectionId);

  // De ponta a ponta: o pareamento por mensagem direta cai na agência do código e a menção no canal dela, no xodó dela.
  assert.equal((await cliente.send(cliente.dm(code, "U0NOVO"))).status, "paired");
  const linked = await one<{ agency_id: string }>(sql, `select agency_id from channel_identities where external_user = $1`, [`${team}:U0NOVO`]);
  assert.equal(linked!.agency_id, cliente.agencyId);
  const model = new FakeModel([{ text: "Oi!" }]);
  const ask = cliente.envelope({ type: "app_mention", channel: "C0CLIENTE", user: "U0NOVO", text: `<@${BOT}> oi` });
  assert.equal((await cliente.send(ask, model)).status, "started");
  const conv = await one<{ agency_id: string; xodo_id: string }>(sql, `select agency_id, xodo_id from xodo_conversations where external_key = $1`, [
    `C0CLIENTE:${ask.event.ts}`,
  ]);
  assert.deepEqual(conv, { agency_id: cliente.agencyId, xodo_id: cliente.xodo.id });

  await sql.query(`update integration_connections set status = 'revoked' where id = $1`, [withXodo.connectionId]);
  assert.equal((await slackConnectionForTeam(sql, team))!.id, without.connectionId);
  assert.equal(await slackConnectionForTeam(sql, `T${rand()}`), null);
  assert.equal(await slackConnectionForTeam(sql, "t' or 1=1 --"), null);
});

/** Espera as execuções dos gatilhos (que seguem em segundo plano) terminarem. */
async function settledRuns(triggerIds: string[]) {
  for (let i = 0; i < 300; i += 1) {
    const rows = await sql.query<{ status: string }>(`select status from xodo_runs where event_trigger_id = any($1::uuid[])`, [triggerIds]);
    if (rows.length >= triggerIds.length && rows.every((r) => r.status !== "running")) return rows.map((r) => r.status);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("as execuções não terminaram");
}

test("gatilhos: mensagem comum de canal dispara os gatilhos de todas as agências do workspace, com o texto limpo e sem repetir", async () => {
  const team = `T${rand()}`;
  const agencia = await world({ team });
  const cliente = await world({ team, channel: false });
  const trigger = async (w: typeof agencia, filters: Record<string, unknown>) => {
    const row = await one<{ id: string }>(
      sql,
      `insert into event_triggers (agency_id, xodo_id, kind, name, connection_id, filters) values ($1, $2, 'slack', 'CPL', $3, $4::jsonb) returning id`,
      [w.agencyId, w.xodo.id, w.connectionId, JSON.stringify(filters)],
    );
    return row!.id;
  };
  const ids = [await trigger(agencia, {}), await trigger(cliente, { channel: "C0CLIENTE" })];
  const model = new FakeModel([{ text: "Anotado." }, { text: "Anotado." }]);
  const msg = agencia.envelope({
    type: "message",
    channel_type: "channel",
    channel: "C0CLIENTE",
    user: "U0ANA",
    text: "subiu o CPL &amp; o CPA, veja <https://x.com/p|o painel>",
  });
  assert.deepEqual(await agencia.send(msg, model), { status: "trigger", fired: 2 });
  assert.deepEqual(await settledRuns(ids), ["completed", "completed"]);
  const deliveries = await sql.query<{ trigger_id: string; outcome: string; delivery_id: string }>(
    `select trigger_id, outcome, delivery_id from event_deliveries where trigger_id = any($1::uuid[]) order by trigger_id`,
    [ids],
  );
  assert.deepEqual(
    deliveries.map((d) => [d.outcome, d.delivery_id]),
    [
      ["accepted", msg.event_id],
      ["accepted", msg.event_id],
    ],
  );
  for (const req of model.requests) assert.ok(JSON.stringify(req.messages).includes("subiu o CPL &amp; o CPA, veja o painel (https://x.com/p)"));
  assert.equal(agencia.api.posts().length + cliente.api.posts().length, 0, "gatilho não conversa no canal");

  // O Slack reenvia o mesmo evento: nenhum gatilho dispara de novo.
  assert.deepEqual(await agencia.send(msg, model), { status: "trigger", fired: 0 });
  // Pessoa de outro workspace (canal compartilhado) não dispara nada.
  const outsider = agencia.envelope({ type: "message", channel_type: "channel", channel: "C0CLIENTE", user: "U0FORA", user_team: "T0OUTRA", text: "oi" });
  assert.deepEqual(await agencia.send(outsider, model), { status: "ignored", detail: "pessoa de outro workspace" });
});

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

test("pareamento por mensagem direta e conversa na thread com o nome do xodó", async () => {
  const w = await world();
  assert.equal((await w.pair()).status, "paired");
  const [ok] = w.api.posts();
  assert.deepEqual(ok, { channel: "D0ANA", text: "Pronto, conta vinculada! Agora é só me chamar por aqui.", unfurl_links: false });
  assert.ok(w.api.f.calls.some((c) => c.url.includes("/users.info?user=U0ANA")), "busca o nome de quem se vincula");
  assert.equal(w.api.f.calls.find((c) => c.url.endsWith("/chat.postMessage"))!.headers.get("authorization"), "Bearer xoxb-teste");
  const identity = await one<{ external_user: string; display_name: string }>(
    sql,
    `select external_user, display_name from channel_identities where agency_id = $1`,
    [w.agencyId],
  );
  assert.deepEqual(identity, { external_user: `${w.team}:U0ANA`, display_name: "Ana" });

  const model = new FakeModel([{ text: "Ontem foram **10 leads** & CPL de R$ 12." }, { text: "De nada!" }]);
  const first = w.mention("como estão os leads?");
  const r = await w.send(first, model);
  assert.equal(r.status, "started");
  const history = JSON.stringify(model.requests[0].messages);
  assert.ok(history.includes("como estão os leads?") && !history.includes(BOT), "sem a menção ao bot");
  const ts = first.event.ts;
  assert.deepEqual(w.api.posts().at(-1), {
    channel: "C0MIDIA",
    text: "Ontem foram *10 leads* &amp; CPL de R$ 12.",
    unfurl_links: false,
    thread_ts: ts,
    username: "Pipoca",
  });
  const conv = await one<{ external_key: string; metadata: Record<string, unknown> }>(
    sql,
    `select external_key, metadata from xodo_conversations where xodo_id = $1`,
    [w.xodo.id],
  );
  assert.deepEqual(conv, { external_key: `C0MIDIA:${ts}`, metadata: { channel: "C0MIDIA", thread_ts: ts } });

  // Resposta na mesma thread continua a mesma conversa; o mesmo evento reenviado é descartado.
  const reply = w.mention("obrigada", { thread_ts: ts });
  assert.equal((await w.send(reply, model)).status, "started");
  assert.equal((await w.send(reply, model)).status, "duplicate");
  const count = await one<{ n: number }>(sql, `select count(*)::int as n from xodo_conversations where xodo_id = $1`, [w.xodo.id]);
  assert.equal(count!.n, 1);
  assert.equal(w.api.posts().at(-1)!.thread_ts, ts);
});

test("filtros: o próprio bot, outro workspace, workspace sem conexão e mensagem comum de canal", async () => {
  const w = await world();
  await w.pair();
  const before = w.api.posts().length;
  const model = new FakeModel([]);
  assert.equal((await w.send(w.dm("oi", BOT), model)).status, "ignored", "o próprio bot");
  const stranger = w.envelope({ type: "app_mention", channel: "C0MIDIA", user: "U0FORA", user_team: "T0OUTRA", text: `<@${BOT}> oi` });
  assert.deepEqual(await w.send(stranger, model), { status: "ignored", detail: "pessoa de outro workspace" });
  const unknownTeam = `T${rand()}`;
  const elsewhere = { ...w.mention("oi", { team: unknownTeam }), team_id: unknownTeam };
  assert.deepEqual(await w.send(elsewhere, model), { status: "ignored", detail: "workspace sem conexão ativa" });

  // Mensagem comum de canal vai para os gatilhos, sem conversa; com menção, quem atende é o app_mention.
  const plain = w.envelope({ type: "message", channel_type: "channel", channel: "C0MIDIA", user: "U0ANA", text: "subiu o CPL" });
  assert.equal((await w.send(plain, model)).status, "trigger");
  const mentioned = w.envelope({ type: "message", channel_type: "channel", channel: "C0MIDIA", user: "U0ANA", text: `<@${BOT}> oi` });
  assert.deepEqual(await w.send(mentioned, model), { status: "ignored", detail: "menção ou o próprio bot" });
  assert.equal(w.api.posts().length, before, "nada foi respondido");
  assert.equal(model.requests.length, 0, "o xodó não foi chamado");
  const convs = await one<{ n: number }>(sql, `select count(*)::int as n from xodo_conversations where xodo_id = $1`, [w.xodo.id]);
  assert.equal(convs!.n, 0);

  // Quem não está vinculado recebe a explicação na mensagem direta; em canal, silêncio.
  assert.equal((await w.send(w.dm("oi", "U0ZE"), model)).status, "unknown_sender");
  assert.equal(w.api.posts().at(-1)!.channel, "D0ZE");
  assert.match(String(w.api.posts().at(-1)!.text), /gere um código no Spherum/);
  const quiet = w.envelope({ type: "app_mention", channel: "C0MIDIA", user: "U0ZE", text: `<@${BOT}> oi` });
  assert.equal((await w.send(quiet, model)).status, "unknown_sender");
  assert.equal(w.api.posts().at(-1)!.channel, "D0ZE");
});

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

test("envio: botões de aprovação em Block Kit, sem nome do xodó sem a permissão, erro do Slack vira exceção", async () => {
  const w = await world({ scopes: ["chat:write", "app_mentions:read"] });
  const a = await access(w.idep, w.agencyId, w.connectionId);
  const actionId = randomUUID();
  await slackAdapter.send(
    { deps: w.idep, access: a, target: { channel: "C0MIDIA", thread_ts: "1760000000.000100" }, xodoName: "Pipoca" },
    { text: "Preciso de aprovação para:\n• mandar <e-mail> ao cliente", approvals: [{ actionId, summary: "mandar e-mail a Ana & Bia <ana@x.com>", index: 1 }] },
  );
  const sent = w.api.posts().at(-1)!;
  assert.equal(sent.username, undefined, "sem chat:write.customize, vai com o nome do app");
  assert.equal(sent.text, "Preciso de aprovação para:\n• mandar &lt;e-mail&gt; ao cliente", "o texto fica como reserva");
  const blocks = sent.blocks as Record<string, unknown>[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "section", "actions"],
  );
  assert.deepEqual(blocks[1].text, { type: "mrkdwn", text: "*1.* mandar e-mail a Ana &amp; Bia &lt;ana@x.com&gt;" });
  assert.deepEqual(blocks[2].elements, [
    { type: "button", action_id: "xodo_aprovar", style: "primary", text: { type: "plain_text", text: "Aprovar" }, value: `ap:${actionId}:1` },
    { type: "button", action_id: "xodo_negar", style: "danger", text: { type: "plain_text", text: "Negar" }, value: `ap:${actionId}:0` },
  ]);

  // Texto longo e cheio de & (que alonga ao escapar) cabe nos blocos de 3000.
  const long = Array.from({ length: 600 }, () => "A&B").join(" ");
  await slackAdapter.send(
    { deps: w.idep, access: a, target: { channel: "C0MIDIA" }, xodoName: null },
    { text: long, approvals: [{ actionId, summary: "x", index: 1 }] },
  );
  const sections = (w.api.posts().at(-1)!.blocks as { type: string; text?: { text: string } }[]).filter((b) => b.type === "section");
  assert.ok(sections.length > 2);
  assert.ok(sections.every((b) => b.text!.text.length <= 3000));
  assert.ok(!("thread_ts" in w.api.posts().at(-1)!));

  // Muitos pedidos: no máximo 50 blocos por mensagem; o que não cabe vira o aviso.
  const many = Array.from({ length: 30 }, (_, i) => ({ actionId: randomUUID(), summary: `pedido ${i + 1}`, index: i + 1 }));
  const plenty = slackBlocks("Preciso de aprovação.", many);
  assert.equal(plenty.filter((b) => b.type === "actions").length, 20);
  assert.equal(plenty.length, 42);
  assert.deepEqual(plenty.at(-1), { type: "context", elements: [{ type: "mrkdwn", text: 'Há mais 10 pedidos: decida no Spherum ou responda "aprovar N".' }] });
  const heavy = slackBlocks("&".repeat(3900), many);
  assert.ok(heavy.length <= 50, `${heavy.length} blocos`);
  assert.ok(heavy.every((b) => b.type !== "section" || (b.text as { text: string }).text.length <= 3000));
  assert.match(JSON.stringify(heavy.at(-1)), /Há mais \d+ pedidos/);
  const ids = heavy.flatMap((b) => (typeof b.block_id === "string" ? [b.block_id] : []));
  assert.equal(new Set(ids).size, ids.length, "block_id único");

  w.api.failPosts({ ok: false, error: "channel_not_found" });
  await assert.rejects(
    slackAdapter.send({ deps: w.idep, access: a, target: { channel: "C0SUMIU" }, xodoName: null }, { text: "oi", approvals: [] }),
    /channel_not_found/,
  );
  await assert.rejects(
    slackAdapter.send({ deps: w.idep, access: a, target: { chat_id: 1 }, xodoName: null }, { text: "oi", approvals: [] }),
    /Destino do Slack inválido/,
  );
});

// ---------------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------------

test("botões: quem não está vinculado não decide; o clique aprova, o xodó continua e a mensagem perde os botões", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "avisar_equipe", input: { titulo: "Atenção", mensagem: "CPL subiu" } }] },
    { text: "Feito, avisei." },
  ]);
  const deps = w.deps(model);
  await w.send(w.mention("avisa a equipe que o CPL subiu"), model);
  const ask = w.api.posts().at(-1)!;
  const blocks = ask.blocks as Record<string, unknown>[];
  assert.ok(blocks.some((b) => b.type === "actions"), "pedido com botões");
  const pending = await one<{ id: string }>(sql, `select id from xodo_actions where status = 'pending' and xodo_id = $1`, [w.xodo.id]);

  const click = (user: string, value: string, extra: Record<string, unknown> = {}) => ({
    type: "block_actions",
    team: { id: w.team, domain: "agencia" },
    user: { id: user, username: "x", team_id: w.team },
    api_app_id: "A0SPHERUM",
    container: { type: "message", message_ts: "1760000000.900000", channel_id: "C0MIDIA" },
    response_url: `https://hooks.slack.com/actions/${w.team}/1/abc`,
    message: { type: "message", text: ask.text, blocks },
    actions: [{ type: "button", action_id: value.endsWith(":1") ? "xodo_aprovar" : "xodo_negar", block_id: "xodo_btn_1", value }],
    ...extra,
  });

  // Quem não está vinculado recebe um aviso só para ele; os botões ficam.
  const intruder = await handleSlackInteraction(deps, ADAPTERS, click("U0ZE", `ap:${pending!.id}:1`));
  assert.equal(intruder.status, "denied");
  assert.deepEqual(w.api.hooks().at(-1), { response_type: "ephemeral", replace_original: false, text: intruder.message });
  // response_url fora do Slack nunca é chamado; botão adulterado é ignorado.
  const hooksBefore = w.api.f.calls.length;
  await handleSlackInteraction(deps, ADAPTERS, click("U0ZE", `ap:${pending!.id}:1`, { response_url: "https://intranet.local/x" }));
  assert.equal(w.api.f.calls.length, hooksBefore);
  const tampered = click("U0ANA", `ap:${pending!.id}:0`);
  tampered.actions[0].action_id = "xodo_aprovar";
  assert.equal((await handleSlackInteraction(deps, ADAPTERS, tampered)).status, "ignored");
  assert.equal((await handleSlackInteraction(deps, ADAPTERS, { ...click("U0ANA", `ap:${pending!.id}:1`), type: "view_submission" })).status, "ignored");
  const other = await handleSlackInteraction(deps, ADAPTERS, click("U0ANA", `ap:${pending!.id}:1`, { user: { id: "U0ANA", team_id: "T0OUTRA" } }));
  assert.equal(other.status, "denied");
  const foreignTeam = { team: { id: "T0OUTRA" }, user: { id: "U0ANA", team_id: "T0OUTRA" } };
  const foreign = await handleSlackInteraction(deps, ADAPTERS, click("U0ANA", `ap:${pending!.id}:1`, foreignTeam));
  assert.equal(foreign.status, "ignored", "o botão só decide pedidos de conversas daquele workspace");
  assert.equal((await one<{ status: string }>(sql, `select status from xodo_actions where id = $1`, [pending!.id]))!.status, "pending");

  // O clique de quem está vinculado aprova, executa e o xodó continua na mesma thread.
  const decided = await handleSlackInteraction(deps, ADAPTERS, click("U0ANA", `ap:${pending!.id}:1`));
  assert.equal(decided.status, "decided");
  const action = await one<{ status: string; decided_by: string; decided_via: string }>(
    sql,
    `select status, decided_by, decided_via from xodo_actions where id = $1`,
    [pending!.id],
  );
  assert.deepEqual(action, { status: "executed", decided_by: w.ownerId, decided_via: "slack" });
  assert.equal(w.api.posts().at(-1)!.text, "Feito, avisei.");
  assert.equal(w.api.posts().at(-1)!.thread_ts, ask.thread_ts);
  const updated = w.api.hooks().at(-1)!;
  assert.equal(updated.replace_original, true);
  assert.equal(updated.text, ask.text);
  const after = updated.blocks as Record<string, unknown>[];
  assert.ok(!after.some((b) => b.type === "actions"), "sem botões");
  assert.deepEqual(after.at(-1), { type: "context", elements: [{ type: "mrkdwn", text: "Aprovado por <@U0ANA>" }] });

  // Clique repetido (na mensagem antiga) mostra que já foi decidido.
  const again = await handleSlackInteraction(deps, ADAPTERS, click("U0ANA", `ap:${pending!.id}:0`));
  assert.equal(again.status, "failed");
  assert.deepEqual((w.api.hooks().at(-1)!.blocks as Record<string, unknown>[]).at(-1), {
    type: "context",
    elements: [{ type: "mrkdwn", text: "Este pedido já foi decidido." }],
  });
});

test("botões: negar, erro antes da decisão mantém os botões, erro depois avisa que foi decidido", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const call = (id: string, titulo: string) => ({ id, name: "avisar_equipe", input: { titulo, mensagem: "CPL subiu" } });
  const model = new FakeModel([{ toolCalls: [call("t1", "Um"), call("t2", "Dois")] }, { text: "Certo." }]);
  const deps = w.deps(model);
  await w.send(w.mention("avisa a equipe duas vezes"), model);
  const ask = w.api.posts().at(-1)!;
  const pending = await sql.query<{ id: string }>(
    `select id from xodo_actions where status = 'pending' and xodo_id = $1 order by call_index`,
    [w.xodo.id],
  );
  assert.equal(pending.length, 2);
  const click = (value: string, blocks: unknown) => ({
    type: "block_actions",
    team: { id: w.team, domain: "agencia" },
    user: { id: "U0ANA", username: "ana", team_id: w.team },
    response_url: `https://hooks.slack.com/actions/${w.team}/2/xyz`,
    message: { type: "message", text: ask.text, blocks },
    actions: [{ type: "button", action_id: value.endsWith(":1") ? "xodo_aprovar" : "xodo_negar", value }],
  });
  const statusOf = async (id: string) => (await one<{ status: string }>(sql, `select status from xodo_actions where id = $1`, [id]))!.status;

  // O banco cai antes de decidir: só quem clicou vê o erro e os botões ficam.
  const broken: ChannelDeps = { ...deps, sql: { query: sql.query, transaction: () => Promise.reject(new Error("banco fora")) } };
  const failed = await handleSlackInteraction(broken, ADAPTERS, click(`ap:${pending[0].id}:0`, ask.blocks));
  assert.equal(failed.status, "failed");
  assert.deepEqual(w.api.hooks().at(-1), { response_type: "ephemeral", replace_original: false, text: failed.message });
  assert.equal(await statusOf(pending[0].id), "pending");

  // Negar o primeiro: os botões dele viram "Negado por", os do segundo continuam.
  const denied = await handleSlackInteraction(deps, ADAPTERS, click(`ap:${pending[0].id}:0`, ask.blocks));
  assert.equal(denied.status, "decided");
  assert.equal(await statusOf(pending[0].id), "denied");
  const afterDeny = w.api.hooks().at(-1)!.blocks as Record<string, unknown>[];
  assert.deepEqual(afterDeny.filter((b) => b.type === "context"), [{ type: "context", elements: [{ type: "mrkdwn", text: "Negado por <@U0ANA>" }] }]);
  assert.equal(afterDeny.filter((b) => b.type === "actions").length, 1);

  // Aprovar o segundo, e o banco cai logo depois da decisão: a mensagem diz que foi aprovado.
  const late: ChannelDeps = {
    ...deps,
    sql: {
      query: (text, params) => (text.includes("select conversation_id from xodo_runs") ? Promise.reject(new Error("banco fora")) : sql.query(text, params)),
      transaction: (fn) => sql.transaction(fn),
    } as ChannelDeps["sql"],
  };
  const approved = await handleSlackInteraction(late, ADAPTERS, click(`ap:${pending[1].id}:1`, afterDeny));
  assert.equal(approved.status, "failed");
  assert.notEqual(await statusOf(pending[1].id), "pending");
  const final = w.api.hooks().at(-1)!;
  assert.equal(final.replace_original, true);
  const finalBlocks = final.blocks as Record<string, unknown>[];
  assert.ok(!finalBlocks.some((b) => b.type === "actions"), "sem botões");
  assert.deepEqual(
    finalBlocks.filter((b) => b.type === "context").map((b) => (b.elements as { text: string }[])[0].text),
    ["Negado por <@U0ANA>", "Aprovado por <@U0ANA>, mas o xodó não conseguiu continuar. Veja no Spherum."],
  );
});

test("o app pede chat:write.customize para o xodó falar com o próprio nome", () => {
  assert.ok(SLACK_BOT_SCOPES.includes("chat:write.customize"));
  assert.equal(new Set(SLACK_BOT_SCOPES).size, SLACK_BOT_SCOPES.length);
});

test("'aprovar' respondido na thread da conversa vale sem mencionar o xodó; em outra thread, não", async () => {
  const w = await world({ autonomy: "sempre_pergunta" });
  await w.pair();
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "avisar_equipe", input: { titulo: "Atenção" } }] },
    { text: "Feito, avisei." },
  ]);
  await w.send(w.mention("avisa a equipe", { ts: "1760000000.100000" }), model);
  const thread = { type: "message", channel_type: "channel", channel: "C0MIDIA", user: "U0ANA" };
  // Em outra thread, "aprovar" é só mensagem comum de canal.
  await w.send(w.envelope({ ...thread, text: "aprovar", ts: "1760000001.000000", thread_ts: "1760000000.999999" }), model);
  const still = await one<{ status: string }>(sql, `select status from xodo_actions where xodo_id = $1`, [w.xodo.id]);
  assert.equal(still!.status, "pending");
  await w.send(w.envelope({ ...thread, text: "aprovar", ts: "1760000002.000000", thread_ts: "1760000000.100000" }), model);
  const done = await one<{ status: string; decided_via: string }>(sql, `select status, decided_via from xodo_actions where xodo_id = $1`, [w.xodo.id]);
  assert.deepEqual(done, { status: "executed", decided_via: "slack" });
  assert.equal(w.api.posts().at(-1)!.text, "Feito, avisei.");
});
