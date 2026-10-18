import assert from "node:assert/strict";
import { before, test } from "node:test";
import { one, type Sql } from "../src/lib/xodos/db";
import { createCredential, createXodo, listCredentials, loadApiKey, revokeCredential, updateXodo } from "../src/lib/xodos/manage";
import { enabledTools } from "../src/lib/xodos/runner";
import { TOOLS } from "../src/lib/xodos/tools";
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

/** O que sai do assistente de criação: forma, cor, nome e jeito, cérebro e limites. */
const escolhas = (credentialId: string, extra = {}) => ({
  name: "Caju",
  species: "bibo",
  color: "Pêssego",
  personality: "zen",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  credential_id: credentialId,
  autonomy: "age_sozinho",
  daily_budget_usd: 4,
  ...extra,
});

test("a chave é guardada cifrada, listada só com os 4 últimos e decifrada para o xodó", async () => {
  const { agencyId, ownerId, credentialId } = await agencyWithKey();
  const stored = await one<{ ciphertext: string }>(sql, `select ciphertext from ai_credentials where id = $1`, [credentialId]);
  assert.ok(!stored!.ciphertext.includes("sk-ant"));
  const [listed] = await listCredentials(sql, agencyId);
  assert.equal(listed.key_last4, "WXYZ");
  assert.equal("ciphertext" in listed, false);

  const xodo = await createXodo(sql, agencyId, escolhas(credentialId), ownerId);
  assert.equal(await loadApiKey(sql, xodo, MASTER), "sk-ant-api03-chave-de-teste-WXYZ");

  await revokeCredential(sql, agencyId, credentialId);
  await assert.rejects(loadApiKey(sql, xodo, MASTER), /revogada/);
});

test("cria o xodó com o que a pessoa escolheu e a saudação do jeito escolhido", async () => {
  const { agencyId, ownerId, credentialId } = await agencyWithKey();
  const client = await seedClient(sql, agencyId, "Loja Verano");
  const xodo = await createXodo(sql, agencyId, escolhas(credentialId, { client_ids: [client] }), ownerId);

  assert.deepEqual(
    [xodo.name, xodo.species, xodo.color, xodo.personality, xodo.autonomy, xodo.role, Number(xodo.daily_budget_usd), xodo.client_scope],
    ["Caju", "bibo", "Pêssego", "zen", "age_sozinho", null, 4, "selected"],
  );
  // Sem função fixa: todas as ferramentas vêm ligadas.
  assert.deepEqual((await enabledTools(sql, xodo)).map((t) => t.name), TOOLS.map((t) => t.name));
  const greeting = await one<{ text: string }>(sql, `select text from xodo_messages where xodo_id = $1`, [xodo.id]);
  assert.equal(greeting!.text, "Olá, sou Caju. Sem pressa — por onde começamos?");
  await assert.rejects(createXodo(sql, agencyId, escolhas(credentialId), ownerId), /Já existe/);
  // Autonomia não informada fica em "pergunta no que importa".
  const other = await createXodo(sql, agencyId, escolhas(credentialId, { name: "Mel", autonomy: undefined }), ownerId);
  assert.equal(other.autonomy, "pergunta_no_que_importa");
});

test("recusa chave de outra agência ou de outro provedor, e cliente de outra agência", async () => {
  const a = await agencyWithKey();
  const b = await agencyWithKey();
  await assert.rejects(createXodo(sql, a.agencyId, escolhas(b.credentialId), a.ownerId), /não existe nesta agência/);
  await assert.rejects(
    createXodo(sql, a.agencyId, escolhas(a.credentialId, { provider: "openai", model: "x", name: "Tico" }), a.ownerId),
    /outro provedor/,
  );
  const foreignClient = await seedClient(sql, b.agencyId, "Cliente da B");
  await assert.rejects(
    createXodo(sql, a.agencyId, escolhas(a.credentialId, { client_ids: [foreignClient], name: "Juju" }), a.ownerId),
    /não é desta agência/,
  );
});

test("pausa e muda o teto; não altera xodó de outra agência", async () => {
  const a = await agencyWithKey();
  const b = await agencyWithKey();
  const xodo = await createXodo(sql, a.agencyId, escolhas(a.credentialId), a.ownerId);
  const updated = await updateXodo(sql, a.agencyId, xodo.id, { status: "paused", daily_budget_usd: 10 });
  assert.equal(updated.status, "paused");
  assert.equal(Number(updated.daily_budget_usd), 10);
  await assert.rejects(updateXodo(sql, b.agencyId, xodo.id, { status: "active" }), /não encontrado/);
});

test("dá para trocar nome, forma, cor, jeito e autonomia depois", async () => {
  const a = await agencyWithKey();
  const xodo = await createXodo(sql, a.agencyId, escolhas(a.credentialId), a.ownerId);
  await createXodo(sql, a.agencyId, escolhas(a.credentialId, { name: "Bento" }), a.ownerId);
  const updated = await updateXodo(sql, a.agencyId, xodo.id, {
    name: "Pixel",
    species: "oki",
    color: "Noite",
    personality: "brincalhao",
    autonomy: "sempre_pergunta",
    role: "Relatórios",
  });
  assert.deepEqual(
    [updated.name, updated.species, updated.color, updated.personality, updated.autonomy, updated.role],
    ["Pixel", "oki", "Noite", "brincalhao", "sempre_pergunta", "Relatórios"],
  );
  await assert.rejects(updateXodo(sql, a.agencyId, xodo.id, { name: "Bento" }), /Já existe/);
});

test("troca o cérebro só com modelo e chave do novo provedor", async () => {
  const a = await agencyWithKey();
  const xodo = await createXodo(sql, a.agencyId, escolhas(a.credentialId), a.ownerId);
  await assert.rejects(updateXodo(sql, a.agencyId, xodo.id, { provider: "openai" }), /informe o modelo e a chave/);
  // A chave atual é da Anthropic, não serve para a OpenAI.
  await assert.rejects(
    updateXodo(sql, a.agencyId, xodo.id, { provider: "openai", model: "modelo-da-agencia", credential_id: a.credentialId }),
    /outro provedor/,
  );
  const openaiKey = await createCredential(
    sql,
    a.agencyId,
    { provider: "openai", label: "OpenAI", api_key: "sk-proj-chave-de-teste-1234" },
    a.ownerId,
    MASTER,
  );
  const swapped = await updateXodo(sql, a.agencyId, xodo.id, { provider: "openai", model: "modelo-da-agencia", credential_id: openaiKey!.id });
  assert.deepEqual([swapped.provider, swapped.model, swapped.credential_id], ["openai", "modelo-da-agencia", openaiKey!.id]);
  assert.equal(await loadApiKey(sql, swapped, MASTER), "sk-proj-chave-de-teste-1234");
});
