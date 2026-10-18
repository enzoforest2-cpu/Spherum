import assert from "node:assert/strict";
import { before, test } from "node:test";
import { one, type Sql } from "../src/lib/xodos/db";
import { createCredential, createXodo, listCredentials, loadApiKey, revokeCredential, updateXodo } from "../src/lib/xodos/manage";
import { createTestDb, seedAgency, seedClient } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function agencyWithKey() {
  const { agencyId, ownerId } = await seedAgency(sql);
  const credential = await createCredential(
    sql,
    agencyId,
    { provider: "anthropic", label: "Conta principal", api_key: "sk-ant-api03-chave-de-teste-WXYZ" },
    ownerId,
    MASTER,
  );
  return { agencyId, ownerId, credentialId: credential!.id };
}

const faisca = (credentialId: string, extra = {}) => ({
  name: "Faísca",
  species: "pingo",
  personality: "curioso",
  role: "relatorios",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  credential_id: credentialId,
  ...extra,
});

test("a chave é guardada cifrada, listada só com os 4 últimos e decifrada para o xodó", async () => {
  const { agencyId, ownerId, credentialId } = await agencyWithKey();
  const stored = await one<{ ciphertext: string }>(sql, `select ciphertext from ai_credentials where id = $1`, [credentialId]);
  assert.ok(!stored!.ciphertext.includes("sk-ant"));
  const [listed] = await listCredentials(sql, agencyId);
  assert.equal(listed.key_last4, "WXYZ");
  assert.equal("ciphertext" in listed, false);

  const xodo = await createXodo(sql, agencyId, faisca(credentialId), ownerId);
  assert.equal(await loadApiKey(sql, xodo, MASTER), "sk-ant-api03-chave-de-teste-WXYZ");

  await revokeCredential(sql, agencyId, credentialId);
  await assert.rejects(loadApiKey(sql, xodo, MASTER), /revogada/);
});

test("cria o xodó com as ferramentas da função, escopo de clientes e a saudação do design", async () => {
  const { agencyId, ownerId, credentialId } = await agencyWithKey();
  const client = await seedClient(sql, agencyId, "Loja Verano");
  const xodo = await createXodo(sql, agencyId, faisca(credentialId, { client_ids: [client] }), ownerId);

  assert.equal(xodo.client_scope, "selected");
  const tools = await sql.query<{ tool_name: string }>(`select tool_name from xodo_tools where xodo_id = $1 order by tool_name`, [xodo.id]);
  assert.ok(tools.some((t) => t.tool_name === "publicar_relatorio"));
  const greeting = await one<{ text: string }>(sql, `select text from xodo_messages where xodo_id = $1`, [xodo.id]);
  assert.equal(greeting!.text, "Oi! Eu sou Faísca. O que a gente descobre hoje?");
  await assert.rejects(createXodo(sql, agencyId, faisca(credentialId), ownerId), /Já existe/);
});

test("recusa chave de outra agência ou de outro provedor, e cliente de outra agência", async () => {
  const a = await agencyWithKey();
  const b = await agencyWithKey();
  await assert.rejects(createXodo(sql, a.agencyId, faisca(b.credentialId), a.ownerId), /não existe nesta agência/);
  await assert.rejects(
    createXodo(sql, a.agencyId, faisca(a.credentialId, { provider: "openai", model: "x", name: "Zuca" }), a.ownerId),
    /outro provedor/,
  );
  const foreignClient = await seedClient(sql, b.agencyId, "Cliente da B");
  await assert.rejects(
    createXodo(sql, a.agencyId, faisca(a.credentialId, { client_ids: [foreignClient], name: "Nina" }), a.ownerId),
    /não é desta agência/,
  );
});

test("pausa e muda o teto; não altera xodó de outra agência", async () => {
  const a = await agencyWithKey();
  const b = await agencyWithKey();
  const xodo = await createXodo(sql, a.agencyId, faisca(a.credentialId), a.ownerId);
  const updated = await updateXodo(sql, a.agencyId, xodo.id, { status: "paused", daily_budget_usd: 10 });
  assert.equal(updated.status, "paused");
  assert.equal(Number(updated.daily_budget_usd), 10);
  await assert.rejects(updateXodo(sql, b.agencyId, xodo.id, { status: "active" }), /não encontrado/);
});
