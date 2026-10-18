import assert from "node:assert/strict";
import { before, test } from "node:test";
import { one, type Sql } from "../src/lib/xodos/db";
import type { LlmClient } from "../src/lib/xodos/llm";
import { createCredential, createXodo, listCredentials, loadCredentialSecret, revokeCredential, updateXodo } from "../src/lib/xodos/manage";
import type { Resolver } from "../src/lib/xodos/net";
import { enabledTools } from "../src/lib/xodos/runner";
import { TOOLS } from "../src/lib/xodos/tools";
import { createTestDb, FakeModel, seedAgency, seedClient } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
let llm: LlmClient;
before(async () => {
  ({ sql } = await createTestDb());
  llm = new FakeModel([]).llm;
});

const publicDns: Resolver = async (host) => [{ address: host.startsWith("interno") ? "10.0.0.5" : "8.8.8.8" }];

async function agencyWithKey() {
  const { agencyId, ownerId } = await seedAgency(sql);
  const credential = await createCredential(
    sql,
    llm,
    agencyId,
    { provider: "faux", label: "Conta principal", api_key: "sk-chave-de-teste-WXYZ" },
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
  provider: "faux",
  model: "faux-1",
  credential_id: credentialId,
  autonomy: "age_sozinho",
  ...extra,
});

test("a chave é guardada cifrada, listada só com os 4 últimos e decifrada na hora da chamada", async () => {
  const { agencyId, ownerId, credentialId } = await agencyWithKey();
  const stored = await one<{ ciphertext: string }>(sql, `select ciphertext from ai_credentials where id = $1`, [credentialId]);
  assert.ok(!stored!.ciphertext.includes("sk-chave"));
  const [listed] = await listCredentials(sql, agencyId);
  assert.equal(listed.key_last4, "WXYZ");
  assert.equal("ciphertext" in listed, false);

  await createXodo(sql, llm, agencyId, escolhas(credentialId), ownerId);
  assert.deepEqual(await loadCredentialSecret(sql, agencyId, credentialId, MASTER), {
    provider: "faux",
    apiKey: "sk-chave-de-teste-WXYZ",
    baseUrl: null,
  });
  const other = await seedAgency(sql, "Outra");
  await assert.rejects(loadCredentialSecret(sql, other.agencyId, credentialId, MASTER), /revogada ou não existe/);

  await revokeCredential(sql, agencyId, credentialId);
  await assert.rejects(loadCredentialSecret(sql, agencyId, credentialId, MASTER), /revogada/);
});

test("provedor fora do catálogo é recusado; servidor próprio exige endereço público", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  const create = (body: Record<string, unknown>) => createCredential(sql, llm, agencyId, body, ownerId, MASTER, publicDns);

  await assert.rejects(create({ provider: "inventado", label: "x", api_key: "sk-123456789" }), /Provedor desconhecido/);
  await assert.rejects(create({ provider: "faux", label: "x", api_key: "curta" }), /chave de API completa/);
  await assert.rejects(create({ provider: "local", label: "Ollama" }), /Informe o endereço/);
  await assert.rejects(create({ provider: "local", label: "Ollama", base_url: "http://localhost:11434/v1" }), /locais não são aceitos/);
  await assert.rejects(create({ provider: "custom", label: "API", base_url: "http://192.168.0.10/v1" }), /rede privada/);
  await assert.rejects(create({ provider: "custom", label: "API", base_url: "https://interno.empresa.com/v1" }), /rede privada/);
  await assert.rejects(create({ provider: "custom", label: "API", base_url: "https://user:senha@ia.exemplo.com" }), /sem usuário e senha/);

  // Ollama exposto pela agência, sem chave, numa porta própria.
  const local = await create({ provider: "local", label: "Ollama", base_url: "https://ollama.agencia.com.br:11434/v1/" });
  assert.deepEqual([local!.provider, local!.base_url, local!.key_last4], ["local", "https://ollama.agencia.com.br:11434/v1", ""]);
  assert.deepEqual(await loadCredentialSecret(sql, agencyId, local!.id, MASTER), {
    provider: "local",
    apiKey: "",
    baseUrl: "https://ollama.agencia.com.br:11434/v1",
  });
  // Com servidor próprio, qualquer nome de modelo vale.
  const xodo = await createXodo(sql, llm, agencyId, escolhas(local!.id, { provider: "local", model: "llama3.3:70b" }), ownerId);
  assert.equal(xodo.model, "llama3.3:70b");
});

test("cria o xodó com o que a pessoa escolheu, reservas em ordem e a saudação do jeito escolhido", async () => {
  const { agencyId, ownerId, credentialId } = await agencyWithKey();
  const client = await seedClient(sql, agencyId, "Loja Verano");
  const xodo = await createXodo(
    sql,
    llm,
    agencyId,
    escolhas(credentialId, {
      client_ids: [client],
      daily_budget_brl: 25,
      backup_models: [{ provider: "faux", model: "faux-2", credential_id: credentialId }],
    }),
    ownerId,
  );

  assert.deepEqual(
    [xodo.name, xodo.species, xodo.color, xodo.personality, xodo.autonomy, xodo.role, Number(xodo.daily_budget_brl), xodo.client_scope],
    ["Caju", "bibo", "Pêssego", "zen", "age_sozinho", null, 25, "selected"],
  );
  const backups = await sql.query(`select position, provider, model from xodo_models where xodo_id = $1`, [xodo.id]);
  assert.deepEqual(backups, [{ position: 1, provider: "faux", model: "faux-2" }]);
  // Sem função fixa: todas as ferramentas vêm ligadas.
  assert.deepEqual((await enabledTools(sql, xodo)).map((t) => t.name), TOOLS.map((t) => t.name));
  const greeting = await one<{ text: string }>(sql, `select text from xodo_messages where xodo_id = $1`, [xodo.id]);
  assert.equal(greeting!.text, "Olá, sou Caju. Sem pressa — por onde começamos?");
  await assert.rejects(createXodo(sql, llm, agencyId, escolhas(credentialId), ownerId), /Já existe/);
  // Sem teto informado: só registra o gasto. Autonomia padrão: pergunta no que importa.
  const other = await createXodo(sql, llm, agencyId, escolhas(credentialId, { name: "Mel", autonomy: undefined }), ownerId);
  assert.equal(other.daily_budget_brl, null);
  assert.equal(other.autonomy, "pergunta_no_que_importa");
});

test("recusa modelo fora do catálogo, chave de outra agência ou de outro provedor, e cliente de outra agência", async () => {
  const a = await agencyWithKey();
  const b = await agencyWithKey();
  await assert.rejects(createXodo(sql, llm, a.agencyId, escolhas(a.credentialId, { model: "nao-existe" }), a.ownerId), /não está no catálogo/);
  await assert.rejects(createXodo(sql, llm, a.agencyId, escolhas(b.credentialId), a.ownerId), /não existe nesta agência/);
  await assert.rejects(
    createXodo(sql, llm, a.agencyId, escolhas(a.credentialId, { provider: "local", model: "x", name: "Tico" }), a.ownerId),
    /outro provedor/,
  );
  await assert.rejects(
    createXodo(sql, llm, a.agencyId, escolhas(a.credentialId, { backup_models: [{ provider: "faux", model: "faux-2", credential_id: b.credentialId }] }), a.ownerId),
    /não existe nesta agência/,
  );
  const foreignClient = await seedClient(sql, b.agencyId, "Cliente da B");
  await assert.rejects(
    createXodo(sql, llm, a.agencyId, escolhas(a.credentialId, { client_ids: [foreignClient], name: "Juju" }), a.ownerId),
    /não é desta agência/,
  );
});

test("pausa, liga o teto e troca as reservas; não altera xodó de outra agência", async () => {
  const a = await agencyWithKey();
  const b = await agencyWithKey();
  const xodo = await createXodo(sql, llm, a.agencyId, escolhas(a.credentialId), a.ownerId);
  const updated = await updateXodo(sql, llm, a.agencyId, xodo.id, {
    status: "paused",
    daily_budget_brl: 50,
    backup_models: [{ provider: "faux", model: "faux-2", credential_id: a.credentialId }],
  });
  assert.equal(updated.status, "paused");
  assert.equal(Number(updated.daily_budget_brl), 50);
  assert.equal((await sql.query(`select 1 from xodo_models where xodo_id = $1`, [xodo.id])).length, 1);
  // Teto nulo volta a só registrar.
  assert.equal((await updateXodo(sql, llm, a.agencyId, xodo.id, { daily_budget_brl: null })).daily_budget_brl, null);
  await assert.rejects(updateXodo(sql, llm, b.agencyId, xodo.id, { status: "active" }), /não encontrado/);
});

test("dá para trocar nome, forma, cor, jeito e autonomia depois", async () => {
  const a = await agencyWithKey();
  const xodo = await createXodo(sql, llm, a.agencyId, escolhas(a.credentialId), a.ownerId);
  await createXodo(sql, llm, a.agencyId, escolhas(a.credentialId, { name: "Bento" }), a.ownerId);
  const updated = await updateXodo(sql, llm, a.agencyId, xodo.id, {
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
  await assert.rejects(updateXodo(sql, llm, a.agencyId, xodo.id, { name: "Bento" }), /Já existe/);
});

test("troca o cérebro só com modelo e chave do novo provedor", async () => {
  const a = await agencyWithKey();
  const xodo = await createXodo(sql, llm, a.agencyId, escolhas(a.credentialId), a.ownerId);
  await assert.rejects(updateXodo(sql, llm, a.agencyId, xodo.id, { provider: "local" }), /informe o modelo e a chave/);
  // A chave atual é do provedor "faux", não serve para "local".
  await assert.rejects(
    updateXodo(sql, llm, a.agencyId, xodo.id, { provider: "local", model: "llama3", credential_id: a.credentialId }),
    /outro provedor/,
  );
  const local = await createCredential(
    sql,
    llm,
    a.agencyId,
    { provider: "local", label: "Ollama", base_url: "https://ollama.agencia.com.br/v1" },
    a.ownerId,
    MASTER,
    publicDns,
  );
  const swapped = await updateXodo(sql, llm, a.agencyId, xodo.id, { provider: "local", model: "llama3", credential_id: local!.id });
  assert.deepEqual([swapped.provider, swapped.model, swapped.credential_id], ["local", "llama3", local!.id]);
});
