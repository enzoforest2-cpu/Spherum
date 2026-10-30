import assert from "node:assert/strict";
import { before, test } from "node:test";
import { getConfig, setConfig } from "../src/lib/core/prospect";
import { generateVariations, submitVariation, syncVariations, toMetaBody } from "../src/lib/core/prospect-variations";
import { saveConnection } from "../src/lib/integrations/store";
import { one, type Sql } from "../src/lib/xodos/db";
import { createCredential } from "../src/lib/xodos/manage";
import { createTestDb, FakeModel, seedAgency } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => { ({ sql } = await createTestDb()); });

test("variações: só com o add-on, IA escreve, Meta recebe o modelo e a aprovada liga sozinha", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  await sql.query(`update agencies set plan = 'agencia', plan_status = 'active' where id = $1`, [agencyId]);
  const model = new FakeModel([
    { text: 'Claro! {"variacoes":[{"estilo":"Pergunta","texto":"Oi {nome}, a {empresa} já anuncia no Instagram?"},{"estilo":"Ruim","texto":"Oi {cliente}"},{"estilo":"Elogio","texto":"{nome}, vi a {empresa} em {cidade} e gostei muito."}]}' },
  ]);
  const calls: { url: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === "POST") return new Response(JSON.stringify({ id: "1", status: "PENDING" }), { status: 200 });
    const name = (calls.find((c) => c.body)!.body as { name: string }).name;
    return new Response(JSON.stringify({ data: [{ name, status: "APPROVED", rejected_reason: "NONE" }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  const integrations = { sql, masterKey: MASTER, fetch, appUrl: "https://spherum.com.br" };
  const deps = { sql, llm: model.llm, masterKey: MASTER, integrations };

  await assert.rejects(generateVariations(deps, agencyId, { base: "Olá {nome}, tudo bem com a {empresa}?" }), /Contrate/);
  await sql.query(`insert into agency_addons (agency_id, addon_id, qty) values ($1, 'disp', 1)`, [agencyId]);
  await assert.rejects(generateVariations(deps, agencyId, { base: "Olá {nome}, tudo bem com a {empresa}?" }), /chave de IA/);

  await createCredential(sql, model.llm, agencyId, { provider: "faux", label: "IA", api_key: "sk-teste-1234" }, ownerId, MASTER);
  const gen = await generateVariations(deps, agencyId, { base: "Olá {nome}, tudo bem com a {empresa}?", count: 3 });
  assert.deepEqual(gen.variations.map((v) => v.style), ["Pergunta", "Elogio"], "a variação com chave inventada cai fora");
  const usage = await one<{ purpose: string; n: number }>(sql, `select purpose, count(*)::int as n from ai_usage where agency_id = $1 group by purpose`, [agencyId]);
  assert.deepEqual(usage, { purpose: "prospeccao", n: 1 });

  await assert.rejects(submitVariation(deps, agencyId, { waba_id: "1234567", style: "x", text: gen.variations[0].text }), /WhatsApp oficial/);
  const conn = await saveConnection(integrations, { agencyId, provider: "whatsapp_cloud", label: "WA", account: "5541", secret: { accessToken: "tok" } });
  await setConfig(sql, agencyId, { connection_id: conn });
  const sent = await submitVariation(deps, agencyId, { waba_id: "1234567", ...gen.variations[1] });
  assert.match(sent.template, /^spherum_v_[0-9a-f]{8}$/);
  const body = calls[0].body as { components: { text: string; example: { body_text: string[][] } }[]; category: string };
  assert.equal(calls[0].url.endsWith("/1234567/message_templates"), true);
  assert.equal(body.category, "MARKETING");
  assert.equal(body.components[0].text, "{{1}}, vi a {{2}} em {{3}} e gostei muito.");
  assert.deepEqual(body.components[0].example.body_text, [["Ana", "Padaria Sol", "Campinas"]]);

  let cfg = await getConfig(sql, agencyId);
  assert.equal(cfg.waba_id, "1234567");
  assert.deepEqual(cfg.variations.map((v) => [v.on, v.status]), [[false, "PENDING"]]);
  // Em análise não pode ser ligada com a prospecção rodando.
  await assert.rejects(setConfig(sql, agencyId, { running: true, steps: [{ t: "a", day: 0, text: "Oi {nome}, responda SAIR", template: "t1" }], variations: cfg.variations.map((v) => ({ ...v, on: true })) }), /modelo aprovado/);

  await syncVariations(deps, agencyId);
  cfg = await getConfig(sql, agencyId);
  assert.deepEqual(cfg.variations.map((v) => [v.on, v.status, v.reason]), [[true, "APPROVED", null]]);
});

test("toMetaBody numera as variáveis na ordem do texto", () => {
  assert.deepEqual(toMetaBody("{empresa} e {nome} e {empresa}"), { body: "{{1}} e {{2}} e {{3}}", examples: ["Padaria Sol", "Ana", "Padaria Sol"] });
});
