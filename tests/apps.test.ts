import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { appAccess } from "../src/lib/integrations/access";
import type { AppId } from "../src/lib/integrations/apps";
import { CONNECTOR_TOOLS } from "../src/lib/integrations/connectors";
import { addresses, htmlToText, internalOnly } from "../src/lib/integrations/connectors/common";
import { offsetOf } from "../src/lib/integrations/connectors/calendar";
import { driveQuery } from "../src/lib/integrations/connectors/drive";
import { githubQuery } from "../src/lib/integrations/connectors/github";
import { buildRaw, messageBody } from "../src/lib/integrations/connectors/gmail";
import { notionId, propValue, textToBlocks } from "../src/lib/integrations/connectors/notion";
import { NATIVE_APP_TOOLS } from "../src/lib/integrations/registry";
import { saveConnection, type IntegrationDeps } from "../src/lib/integrations/store";
import { one, type Sql } from "../src/lib/xodos/db";
import { continueRun, startRun, toolsFor } from "../src/lib/xodos/runner";
import { toolJsonSchema, type ToolContext, type ToolDef } from "../src/lib/xodos/tools";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const NOW = new Date("2026-10-19T12:00:00Z");
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
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

type Setup = {
  provider: string;
  apps: AppId[];
  handler: (c: Call) => unknown;
  account?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  autonomy?: string;
};

async function setup(o: Setup) {
  const f = fakeFetch(o.handler);
  const { agencyId, ownerId } = await seedAgency(sql);
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: f.fn, appUrl: "https://spherum.com.br", now: () => NOW };
  await saveConnection(deps, {
    agencyId,
    provider: o.provider,
    label: o.provider,
    account: o.account ?? `${o.provider}-${agencyId}`,
    scopes: o.scopes ?? [],
    secret: { accessToken: "tok" },
    metadata: o.metadata,
  });
  const xodo = await seedXodo(sql, agencyId, { autonomy: o.autonomy ?? "pergunta_no_que_importa" });
  for (const app of o.apps) await sql.query(`insert into xodo_apps (xodo_id, agency_id, app) values ($1, $2, $3)`, [xodo.id, agencyId, app]);
  const ctx: ToolContext = { sql, xodo, runId: randomUUID(), now: NOW, apps: appAccess(deps, xodo) };
  const tool = (name: string) => CONNECTOR_TOOLS.find((t) => t.name === name) as ToolDef<Record<string, unknown>>;
  const run = (name: string, input: Record<string, unknown>) => tool(name).execute(ctx, tool(name).input.parse(input));
  const category = (name: string, input: Record<string, unknown>) => tool(name).categoryFor!(ctx, tool(name).input.parse(input));
  const engine = (model: FakeModel) => ({
    ...testDeps(sql, model, new Clock(NOW)),
    integrations: { masterKey: MASTER, fetch: f.fn, appUrl: "https://spherum.com.br" },
  });
  return { f, ctx, xodo, agencyId, ownerId, run, category, engine };
}

const G = "https://www.googleapis.com/auth/";

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

test("ferramentas de app: nomes válidos e únicos, todas ligadas a um app e com esquema de objeto", () => {
  const names = new Set<string>();
  for (const t of NATIVE_APP_TOOLS) {
    assert.match(t.name, /^[a-z0-9_]{1,64}$/, t.name);
    assert.ok(!names.has(t.name), `nome repetido: ${t.name}`);
    names.add(t.name);
    assert.ok(t.app, `${t.name} sem app`);
    const schema = toolJsonSchema(t);
    assert.equal(schema.type, "object", t.name);
    assert.ok(!("allOf" in schema) && !("anyOf" in schema), `${t.name} com combinador no topo`);
  }
  for (const app of ["gmail", "calendar", "drive", "slack", "notion", "github"]) {
    assert.ok(CONNECTOR_TOOLS.some((t) => [t.app].flat().includes(app as AppId)), app);
  }
});

test("só aparecem as ferramentas dos apps liberados ao xodó", async () => {
  const s = await setup({ provider: "google", apps: ["gmail"], scopes: [`${G}gmail.modify`], handler: () => ({}) });
  const names = (await toolsFor(s.engine(new FakeModel([])), s.xodo)).map((t) => t.name);
  assert.ok(names.includes("buscar_emails") && names.includes("enviar_email"));
  assert.ok(!names.includes("ver_agenda") && !names.includes("enviar_mensagem_no_slack"));
});

test("ajudas: HTML vira texto, endereços e quem é de dentro da empresa", () => {
  assert.equal(
    htmlToText('<p>Oi&nbsp;Ana,</p><p>Veja <a href="https://x.com/r">o relatório</a> &amp; me diga.<br>Abs</p><style>p{}</style>'),
    "Oi Ana,\nVeja o relatório (https://x.com/r) & me diga.\nAbs",
  );
  assert.deepEqual(addresses('"Ana Lima" <Ana@Cliente.com>, bia@agencia.com.br'), ["ana@cliente.com", "bia@agencia.com.br"]);
  assert.equal(internalOnly("eu@agencia.com.br", ["bia@agencia.com.br"]), true);
  assert.equal(internalOnly("eu@agencia.com.br", ["bia@agencia.com.br", "ana@cliente.com"]), false);
  assert.equal(internalOnly("eu@gmail.com", ["amigo@gmail.com"]), false, "provedor aberto não é empresa");
  assert.equal(internalOnly("eu@agencia.com.br", []), false);
});

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

const gmailMessage = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Segue o briefing",
  payload: {
    headers: [
      { name: "From", value: "Ana <ana@cliente.com>" },
      { name: "To", value: "eu@agencia.com.br" },
      { name: "Subject", value: "Briefing" },
      { name: "Date", value: "Mon, 19 Oct 2026 09:00:00 -0300" },
      { name: "Message-ID", value: "<abc@mail.cliente.com>" },
    ],
    ...extra,
  },
});

test("Gmail: busca com resumo e leitura com texto e anexos", async () => {
  const s = await setup({
    provider: "google",
    apps: ["gmail"],
    scopes: [`${G}gmail.modify`],
    handler: (c) => {
      if (c.url.includes("/messages?")) return { messages: [{ id: "m1" }], resultSizeEstimate: 1 };
      if (c.url.includes("format=full")) {
        return gmailMessage("m1", {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "multipart/alternative", parts: [
              { mimeType: "text/plain", body: { data: b64url("Olá! Segue o briefing.\nAbs, Ana") } },
              { mimeType: "text/html", body: { data: b64url("<p>Olá!</p>") } },
            ] },
            { mimeType: "application/pdf", filename: "briefing.pdf", body: { attachmentId: "a1", size: 2048 } },
          ],
        });
      }
      return gmailMessage("m1");
    },
  });
  const found = (await s.run("buscar_emails", { busca: "from:ana@cliente.com is:unread" })) as { emails: Record<string, unknown>[] };
  assert.deepEqual(found.emails[0], {
    id: "m1",
    conversa: "t1",
    de: "Ana <ana@cliente.com>",
    para: "eu@agencia.com.br",
    assunto: "Briefing",
    data: "Mon, 19 Oct 2026 09:00:00 -0300",
    trecho: "Segue o briefing",
    nao_lido: true,
  });
  assert.equal(new URL(s.f.calls[0].url).searchParams.get("q"), "from:ana@cliente.com is:unread");
  assert.equal(s.f.calls[0].headers.get("authorization"), "Bearer tok");

  const read = (await s.run("ler_email", { id: "m1" })) as { emails: { texto: string; anexos: unknown[] }[] };
  assert.equal(read.emails[0].texto, "Olá! Segue o briefing.\nAbs, Ana");
  assert.deepEqual(read.emails[0].anexos, [{ nome: "briefing.pdf", tipo: "application/pdf", tamanho: 2048 }]);
  // Só HTML: converte para texto.
  assert.equal(messageBody({ mimeType: "text/html", body: { data: b64url("<div>Oi<br>tudo bem?</div>") } }).text, "Oi\ntudo bem?");
});

test("Gmail: mensagem montada sem injeção de cabeçalho e com acentos codificados", () => {
  const raw = decodeRaw(buildRaw({ to: ["ana@cliente.com"], cc: [], bcc: [], subject: "Relatório\r\nBcc: espiao@x.com", text: "Olá, Ana" }));
  const [head, body] = raw.split("\r\n\r\n");
  assert.ok(!/^Bcc:/m.test(head), "a quebra de linha no assunto não vira cabeçalho");
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
  const subject = head.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)![1];
  assert.equal(Buffer.from(subject, "base64").toString("utf8"), "Relatório Bcc: espiao@x.com");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Olá, Ana");
});

test("Gmail: resposta vai para quem mandou, na mesma conversa, com Re: e In-Reply-To", async () => {
  const s = await setup({
    provider: "google",
    apps: ["gmail"],
    scopes: [`${G}gmail.modify`],
    account: "eu@agencia.com.br",
    handler: (c) => (c.url.endsWith("/drafts") ? { id: "d1", message: { id: "m9", threadId: "t1" } } : gmailMessage("m1")),
  });
  const out = (await s.run("rascunho_de_email", { texto: "Recebido, obrigado!", responder_a: "m1" })) as Record<string, unknown>;
  assert.deepEqual(out, { rascunho_id: "d1", para: ["ana@cliente.com"], assunto: "Re: Briefing", conversa: "t1" });
  const post = JSON.parse(s.f.calls.find((c) => c.method === "POST")!.body);
  assert.equal(post.message.threadId, "t1");
  const raw = decodeRaw(post.message.raw);
  assert.match(raw, /^To: ana@cliente\.com$/m);
  assert.match(raw, /^In-Reply-To: <abc@mail\.cliente\.com>$/m);
  assert.match(raw, /^References: <abc@mail\.cliente\.com>$/m);
});

test("Gmail: para colega do mesmo domínio vai direto; para fora espera aprovação", async () => {
  const s = await setup({
    provider: "google",
    apps: ["gmail"],
    scopes: [`${G}gmail.modify`],
    account: "eu@agencia.com.br",
    handler: (c) => (c.url.endsWith("/messages/send") ? { id: "s1", threadId: "t9" } : {}),
  });
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "enviar_email", input: { para: ["bia@agencia.com.br"], assunto: "Pauta", texto: "Segue a pauta." } },
        { id: "t2", name: "enviar_email", input: { para: ["ana@cliente.com"], assunto: "Proposta", texto: "Segue a proposta." } },
      ],
    },
  ]);
  const engine = s.engine(model);
  const runId = await startRun(engine, { xodoId: s.xodo.id, agencyId: s.agencyId, trigger: "user", text: "Manda os e-mails", userId: s.ownerId });
  assert.equal(await continueRun(engine, runId), "waiting_approval");
  const actions = await sql.query<{ category: string; status: string }>(
    `select category, status from xodo_actions where run_id = $1 order by call_index`,
    [runId],
  );
  assert.deepEqual(actions, [
    { category: "equipe", status: "executed" },
    { category: "envio", status: "pending" },
  ]);
  const sends = s.f.calls.filter((c) => c.url.endsWith("/messages/send"));
  assert.equal(sends.length, 1);
  assert.match(decodeRaw(JSON.parse(sends[0].body).raw), /^To: bia@agencia\.com\.br$/m);
});

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

test("Agenda: período no fuso do xodó e evento de dia inteiro com o último dia certo", async () => {
  const s = await setup({
    provider: "google",
    apps: ["calendar"],
    scopes: [`${G}calendar.events`],
    handler: () => ({
      items: [
        { id: "e1", summary: "Reunião com a Verano", start: { dateTime: "2026-10-20T14:00:00-03:00" }, end: { dateTime: "2026-10-20T15:00:00-03:00" }, attendees: [{ email: "ana@cliente.com", responseStatus: "accepted" }], hangoutLink: "https://meet.google.com/x" },
        { id: "e2", summary: "Feriado", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } },
      ],
    }),
  });
  assert.equal(offsetOf("America/Sao_Paulo", NOW), "-03:00");
  const out = (await s.run("ver_agenda", {})) as { eventos: Record<string, unknown>[] };
  const params = new URL(s.f.calls[0].url).searchParams;
  assert.equal(params.get("timeMin"), "2026-10-19T00:00:00-03:00");
  assert.equal(params.get("timeMax"), "2026-10-27T00:00:00-03:00");
  assert.equal(params.get("singleEvents"), "true");
  assert.match(s.f.calls[0].url, /\/calendars\/primary\/events\?/);
  assert.equal(out.eventos[0].link_meet, "https://meet.google.com/x");
  assert.deepEqual([out.eventos[1].inicio, out.eventos[1].fim, out.eventos[1].dia_inteiro], ["2026-11-02", "2026-11-02", true]);
});

test("Agenda: criar evento (dia inteiro, com horário e Meet) e categoria pelos convidados", async () => {
  const s = await setup({
    provider: "google",
    apps: ["calendar"],
    scopes: [`${G}calendar.events`],
    account: "eu@agencia.com.br",
    handler: (c) => (c.method === "POST" ? { id: "novo", ...JSON.parse(c.body) } : {}),
  });
  await s.run("criar_evento", { titulo: "Imersão", inicio: "2026-10-20", fim: "2026-10-21" });
  let body = JSON.parse(s.f.calls.at(-1)!.body);
  assert.deepEqual([body.start, body.end], [{ date: "2026-10-20" }, { date: "2026-10-22" }]);
  assert.equal(new URL(s.f.calls.at(-1)!.url).searchParams.get("sendUpdates"), "all");

  await s.run("criar_evento", { titulo: "Call", inicio: "2026-10-20T14:00", convidados: ["bia@agencia.com.br"], criar_meet: true });
  body = JSON.parse(s.f.calls.at(-1)!.body);
  assert.deepEqual(body.start, { dateTime: "2026-10-20T14:00", timeZone: "America/Sao_Paulo" });
  assert.deepEqual(body.end, { dateTime: "2026-10-20T15:00:00", timeZone: "America/Sao_Paulo" });
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(new URL(s.f.calls.at(-1)!.url).searchParams.get("conferenceDataVersion"), "1");

  await assert.rejects(s.run("criar_evento", { titulo: "x", inicio: "2026-10-20", fim: "2026-10-20T10:00" }), /dia inteiro/);
  assert.equal(await s.category("criar_evento", { titulo: "x", inicio: "2026-10-20", convidados: ["bia@agencia.com.br"] }), "alteracao");
  assert.equal(await s.category("criar_evento", { titulo: "x", inicio: "2026-10-20", convidados: ["ana@cliente.com"] }), "envio");
  assert.equal(
    await s.category("criar_evento", { titulo: "x", inicio: "2026-10-20", convidados: ["ana@cliente.com"], avisar_convidados: false }),
    "alteracao",
  );
});

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

test("Drive: busca com aspas escapadas, leitura de Documento como texto e criação de documento", async () => {
  assert.equal(
    driveQuery({ busca: "O'Neil \\ x", tipo: "planilha" }),
    "trashed = false and (name contains 'O\\'Neil \\\\ x' or fullText contains 'O\\'Neil \\\\ x') and mimeType = 'application/vnd.google-apps.spreadsheet'",
  );
  const s = await setup({
    provider: "google",
    apps: ["drive"],
    scopes: [`${G}drive.readonly`, `${G}drive.file`],
    handler: (c) => {
      if (c.url.includes("/export?")) return new Response("123", { status: 200, headers: { "content-type": "text/plain" } });
      if (c.url.includes("/files/pdf1?")) return { id: "pdf1", name: "Contrato.pdf", mimeType: "application/pdf" };
      if (c.url.includes("/upload/")) return { id: "novo", name: "Relatório", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/d/novo" };
      return { id: "doc1", name: "Pauta", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/d/doc1" };
    },
  });
  const doc = (await s.run("ler_arquivo_do_drive", { id: "doc1" })) as Record<string, unknown>;
  assert.equal(doc.conteudo, "123", "o texto exportado não é interpretado como JSON");
  assert.equal(doc.tipo, "Documento");
  const pdf = (await s.run("ler_arquivo_do_drive", { id: "pdf1" })) as Record<string, unknown>;
  assert.equal(pdf.conteudo, null);
  assert.match(String(pdf.aviso), /link/);

  const created = (await s.run("criar_documento_no_drive", { nome: "Relatório", texto: "Resumo da semana" })) as Record<string, unknown>;
  assert.equal(created.link, "https://docs.google.com/d/novo");
  const upload = s.f.calls.find((c) => c.url.includes("/upload/"))!;
  assert.match(upload.url, /uploadType=multipart/);
  assert.match(upload.headers.get("content-type")!, /^multipart\/related; boundary=spherum-/);
  assert.match(upload.body, /"mimeType":"application\/vnd\.google-apps\.document"/);
  assert.match(upload.body, /Resumo da semana/);
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

function slackApi(extra: (c: Call) => unknown = () => undefined) {
  let posts = 0;
  return (c: Call) => {
    const custom = extra(c);
    if (custom !== undefined) return custom;
    if (c.url.includes("conversations.list")) {
      return { ok: true, channels: [{ id: "C0GERAL01", name: "geral", is_member: false }, { id: "C0VERANO1", name: "verano-agencia", is_ext_shared: true, is_member: true }] };
    }
    if (c.url.includes("conversations.info")) {
      const channel = new URL(c.url).searchParams.get("channel");
      if (channel === "C0VERANO1") return { ok: true, channel: { id: "C0VERANO1", is_ext_shared: true } };
      if (channel === "D0ANA0001") return { ok: true, channel: { id: "D0ANA0001", is_im: true, user: "U9" } };
      if (channel === "C0SUMIU01") return { ok: false, error: "channel_not_found" };
      return { ok: true, channel: { id: channel } };
    }
    if (c.url.includes("users.info")) {
      return { ok: true, user: { id: "U9", real_name: "Ana", team_id: "T-OUTRA" } };
    }
    if (c.url.includes("conversations.history")) {
      return { ok: true, messages: [{ ts: "2.0", user: "U9", text: "segunda" }, { ts: "1.0", user: "U9", text: "primeira", reply_count: 2 }, { ts: "1.5", subtype: "channel_join", user: "U9" }] };
    }
    if (c.url.includes("chat.postMessage")) {
      posts += 1;
      if (posts === 1 && JSON.parse(c.body).channel === "C0GERAL01") return { ok: false, error: "not_in_channel" };
      return { ok: true, ts: "9.9", channel: JSON.parse(c.body).channel };
    }
    return { ok: true };
  };
}

test("Slack: canal pelo nome, entra no canal público se precisar e lê na ordem da conversa", async () => {
  const s = await setup({ provider: "slack", apps: ["slack"], metadata: { team_id: "T1" }, handler: slackApi() });
  const sent = (await s.run("enviar_mensagem_no_slack", { canal: "#geral", texto: "Relatório no ar!" })) as Record<string, unknown>;
  assert.deepEqual(sent, { enviado: true, canal: "C0GERAL01", ts: "9.9" });
  const methods = s.f.calls.map((c) => new URL(c.url).pathname.split("/").pop());
  assert.deepEqual(methods, ["conversations.list", "chat.postMessage", "conversations.join", "chat.postMessage"]);

  const read = (await s.run("ler_canal_do_slack", { canal: "C0GERAL01" })) as { mensagens: Record<string, unknown>[] };
  assert.deepEqual(read.mensagens.map((m) => [m.texto, m.quem, m.respostas]), [["primeira", "Ana", 2], ["segunda", "Ana", 0]]);
});

test("Slack: canal interno é equipe; Slack Connect e conversa com gente de fora são envio", async () => {
  const s = await setup({ provider: "slack", apps: ["slack"], metadata: { team_id: "T1" }, handler: slackApi() });
  assert.equal(await s.category("enviar_mensagem_no_slack", { canal: "C0GERAL01", texto: "oi" }), "equipe");
  assert.equal(await s.category("enviar_mensagem_no_slack", { canal: "C0VERANO1", texto: "oi" }), "envio");
  assert.equal(await s.category("enviar_mensagem_no_slack", { canal: "D0ANA0001", texto: "oi" }), "envio");
  assert.throws(() => CONNECTOR_TOOLS.find((t) => t.name === "enviar_mensagem_no_slack")!.input.parse({ texto: "oi" }), /canal ou a pessoa/);
});

test("Slack no motor: interno vai direto; se não der para ver o canal, fica a categoria cautelosa", async () => {
  const s = await setup({ provider: "slack", apps: ["slack"], metadata: { team_id: "T1" }, handler: slackApi() });
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "enviar_mensagem_no_slack", input: { canal: "C0TIME001", texto: "Bom dia, time" } },
        { id: "t2", name: "enviar_mensagem_no_slack", input: { canal: "C0SUMIU01", texto: "?" } },
      ],
    },
  ]);
  const engine = s.engine(model);
  const runId = await startRun(engine, { xodoId: s.xodo.id, agencyId: s.agencyId, trigger: "user", text: "Avisa o time", userId: s.ownerId });
  assert.equal(await continueRun(engine, runId), "waiting_approval");
  const actions = await sql.query<{ category: string; status: string }>(`select category, status from xodo_actions where run_id = $1 order by call_index`, [runId]);
  assert.deepEqual(actions, [
    { category: "equipe", status: "executed" },
    { category: "envio", status: "pending" },
  ]);
});

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

test("Notion: id a partir do link, texto em blocos e valores das propriedades", () => {
  assert.equal(notionId("https://www.notion.so/agencia/Cafe-1a2b3c4d5e6f70819a2b3c4d5e6f7081?pvs=4"), "1a2b3c4d5e6f70819a2b3c4d5e6f7081");
  assert.equal(notionId("1a2b3c4d-5e6f-7081-9a2b-3c4d5e6f7081"), "1a2b3c4d5e6f70819a2b3c4d5e6f7081");
  assert.throws(() => notionId("nada"), /inválido/);
  const blocks = textToBlocks("# Pauta\n- item\n- [x] feito\n1. primeiro\n\n```\ncódigo\n```\ntexto");
  assert.deepEqual(blocks.map((b) => b.type), ["heading_1", "bulleted_list_item", "to_do", "numbered_list_item", "code", "paragraph"]);
  assert.equal((blocks[2].to_do as { checked: boolean }).checked, true);
  // Trechos de até 2000 caracteres, como o Notion exige.
  const long = textToBlocks("a".repeat(4500))[0].paragraph as { rich_text: unknown[] };
  assert.equal(long.rich_text.length, 3);
  assert.equal(propValue({ type: "status", status: { name: "Feito" } }), "Feito");
  assert.deepEqual(propValue({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] }), ["a", "b"]);
  assert.equal(propValue({ type: "formula", formula: { type: "number", number: 3 } }), 3);
  assert.equal(propValue({ type: "unique_id", unique_id: { prefix: "TAR", number: 12 } }), "TAR-12");
});

test("Notion: linha numa base com as propriedades no formato certo; em página, só o título", async () => {
  const DB = "1a2b3c4d5e6f70819a2b3c4d5e6f7081";
  const PAGE = "9f8e7d6c5b4a39281f0e9d8c7b6a5948";
  const s = await setup({
    provider: "notion",
    apps: ["notion"],
    handler: (c) => {
      if (c.url.endsWith(`/databases/${DB}`)) {
        return { id: DB, object: "database", properties: { Tarefa: { type: "title" }, Status: { type: "status" }, Prazo: { type: "date" }, Horas: { type: "number" }, Tags: { type: "multi_select" } } };
      }
      if (c.url.endsWith(`/databases/${PAGE}`)) return new Response(JSON.stringify({ object: "error", message: "Could not find database" }), { status: 404 });
      if (c.url.endsWith("/pages")) return { id: "nova", object: "page", url: "https://notion.so/nova" };
      return {};
    },
  });
  await s.run("criar_pagina_no_notion", {
    dentro_de: `https://www.notion.so/agencia/Tarefas-${DB}?v=abc`,
    titulo: "Revisar criativos",
    texto: "- ver peças\n- aprovar",
    propriedades: { Status: "Em andamento", Prazo: "2026-10-25", Horas: "1,5", Tags: ["verano", "meta"] },
  });
  const post = s.f.calls.find((c) => c.url.endsWith("/pages"))!;
  assert.equal(post.headers.get("notion-version"), "2022-06-28");
  const body = JSON.parse(post.body);
  assert.deepEqual(body.parent, { database_id: DB });
  assert.deepEqual(body.properties, {
    Status: { status: { name: "Em andamento" } },
    Prazo: { date: { start: "2026-10-25" } },
    Horas: { number: 1.5 },
    Tags: { multi_select: [{ name: "verano" }, { name: "meta" }] },
    Tarefa: { title: [{ type: "text", text: { content: "Revisar criativos" } }] },
  });
  assert.equal(body.children.length, 2);
  await assert.rejects(s.run("criar_pagina_no_notion", { dentro_de: DB, titulo: "x", propriedades: { Dono: "Ana" } }), /não tem a propriedade "Dono"/);

  await s.run("criar_pagina_no_notion", { dentro_de: PAGE, titulo: "Ata" });
  const second = JSON.parse(s.f.calls.filter((c) => c.url.endsWith("/pages")).at(-1)!.body);
  assert.deepEqual(second.parent, { page_id: PAGE });
  assert.deepEqual(Object.keys(second.properties), ["title"]);
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

test("GitHub: busca com is:issue, arquivo decodificado e binário recusado", async () => {
  assert.equal(githubQuery("repo:agencia/site label:bug", "issue"), "repo:agencia/site label:bug is:issue");
  assert.equal(githubQuery("repo:agencia/site is:pr is:open", "issue"), "repo:agencia/site is:pr is:open");
  const s = await setup({
    provider: "github",
    apps: ["github"],
    scopes: ["repo", "read:user", "read:org"],
    handler: (c) => {
      if (c.url.includes("/contents/README.md")) return { type: "file", encoding: "base64", content: Buffer.from("# Site\nOlá").toString("base64"), size: 10 };
      if (c.url.includes("/contents/logo.png")) return { type: "file", encoding: "base64", content: Buffer.from([0x89, 0x50, 0x00, 0x01]).toString("base64") };
      if (c.url.includes("/contents/")) return [{ name: "README.md", type: "file", path: "README.md" }];
      return { total_count: 0, items: [] };
    },
  });
  const file = (await s.run("ler_arquivo_do_github", { repo: "agencia/site", caminho: "README.md" })) as Record<string, unknown>;
  assert.equal(file.conteudo, "# Site\nOlá");
  assert.equal(s.f.calls[0].headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(s.f.calls[0].headers.get("user-agent"), "Spherum");
  const dir = (await s.run("ler_arquivo_do_github", { repo: "agencia/site" })) as { itens: unknown[] };
  assert.equal(dir.itens.length, 1);
  await assert.rejects(s.run("ler_arquivo_do_github", { repo: "agencia/site", caminho: "logo.png" }), /binário/);
  assert.throws(() => CONNECTOR_TOOLS.find((t) => t.name === "ler_issue_do_github")!.input.parse({ repo: "../etc", numero: 1 }));
});

test("GitHub no motor: comentário em repositório privado vai direto; em público espera aprovação", async () => {
  const s = await setup({
    provider: "github",
    apps: ["github"],
    scopes: ["repo", "read:user", "read:org"],
    handler: (c) => {
      if (c.url.endsWith("/repos/agencia/interno")) return { private: true };
      if (c.url.endsWith("/repos/agencia/open-source")) return { private: false };
      if (c.method === "POST") return { html_url: "https://github.com/x/1#c" };
      return {};
    },
  });
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "comentar_no_github", input: { repo: "agencia/interno", numero: 3, texto: "Corrigido no deploy de hoje." } },
        { id: "t2", name: "comentar_no_github", input: { repo: "agencia/open-source", numero: 7, texto: "Obrigado!" } },
      ],
    },
  ]);
  const engine = s.engine(model);
  const runId = await startRun(engine, { xodoId: s.xodo.id, agencyId: s.agencyId, trigger: "user", text: "Comenta", userId: s.ownerId });
  assert.equal(await continueRun(engine, runId), "waiting_approval");
  const actions = await sql.query<{ category: string; status: string }>(`select category, status from xodo_actions where run_id = $1 order by call_index`, [runId]);
  assert.deepEqual(actions, [
    { category: "alteracao", status: "executed" },
    { category: "envio", status: "pending" },
  ]);
  const posts = s.f.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/repos\/agencia\/interno\/issues\/3\/comments$/);
  const pending = await one<{ reason: string }>(sql, `select reason from xodo_actions where run_id = $1 and status = 'pending'`, [runId]);
  assert.equal(pending!.reason, "autonomy");
});
