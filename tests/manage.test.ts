import assert from "node:assert/strict";
import { before, test } from "node:test";
import { one, type Sql } from "../src/lib/xodos/db";
import type { LlmClient } from "../src/lib/xodos/llm";
import { createCredential, createXodo, listCredentials, loadCredentialSecret, revokeCredential, updateXodo } from "../src/lib/xodos/manage";
import type { Resolver } from "../src/lib/xodos/net";
import { enabledTools } from "../src/lib/xodos/runner";
import { MEMORY_TOOLS } from "../src/lib/xodos/memory/tools";
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
  // Vários xodós na mesma agência: plano Rede (o teste grátis permite 1).
  await sql.query(`update agencies set plan = 'rede', plan_status = 'active' where id = $1`, [agencyId]);
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
      routine_model: { provider: "faux", model: "faux-2", credential_id: credentialId },
    }),
    ownerId,
  );
  assert.deepEqual([xodo.routine_provider, xodo.routine_model], ["faux", "faux-2"]);
  const cleared = await updateXodo(sql, llm, agencyId, xodo.id, { routine_model: null });
  assert.deepEqual([cleared.routine_provider, cleared.routine_model, cleared.routine_credential_id], [null, null, null]);
  await assert.rejects(
    updateXodo(sql, llm, agencyId, xodo.id, { routine_model: { provider: "faux", model: "nao-existe", credential_id: credentialId } }),
    /não está no catálogo/,
  );

  assert.deepEqual(
    [xodo.name, xodo.species, xodo.color, xodo.personality, xodo.autonomy, xodo.role, Number(xodo.daily_budget_brl), xodo.client_scope],
    ["Caju", "bibo", "Pêssego", "zen", "age_sozinho", null, 25, "selected"],
  );
  const backups = await sql.query(`select position, provider, model from xodo_models where xodo_id = $1`, [xodo.id]);
  assert.deepEqual(backups, [{ position: 1, provider: "faux", model: "faux-2" }]);
  // Sem função fixa: todas as ferramentas vêm ligadas.
  assert.deepEqual((await enabledTools(sql, xodo)).map((t) => t.name), [...TOOLS, ...MEMORY_TOOLS].map((t) => t.name));
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

test("um PATCH com um campo só não mexe no resto", async () => {
  const a = await agencyWithKey();
  const xodo = await createXodo(
    sql,
    llm,
    a.agencyId,
    escolhas(a.credentialId, {
      instructions: "Sempre em tópicos.",
      daily_budget_brl: 30,
      backup_models: [{ provider: "faux", model: "faux-2", credential_id: a.credentialId }],
      routine_model: { provider: "faux", model: "faux-2", credential_id: a.credentialId },
    }),
    a.ownerId,
  );
  const paused = await updateXodo(sql, llm, a.agencyId, xodo.id, { status: "paused" });
  assert.deepEqual(
    [paused.status, paused.autonomy, paused.instructions, Number(paused.daily_budget_brl), paused.routine_model],
    ["paused", "age_sozinho", "Sempre em tópicos.", 30, "faux-2"],
  );
  assert.equal((await sql.query(`select 1 from xodo_models where xodo_id = $1`, [xodo.id])).length, 1);
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

test("apps do xodó (Pode mexer em): conexão fixada precisa ser da agência e do provedor do app", async () => {
  const a = await agencyWithKey();
  const b = await agencyWithKey();
  const insertConn = async (agencyId: string, provider: string) =>
    (await one<{ id: string }>(
      sql,
      `insert into integration_connections (agency_id, provider, label, ciphertext) values ($1, $2, 'x', 'v1:x') returning id`,
      [agencyId, provider],
    ))!.id;
  const googleA = await insertConn(a.agencyId, "google");
  const slackA = await insertConn(a.agencyId, "slack");
  const googleB = await insertConn(b.agencyId, "google");

  const xodo = await createXodo(sql, llm, a.agencyId, escolhas(a.credentialId, { apps: [{ app: "gmail" }, { app: "calendar", connection_id: googleA }] }), a.ownerId);
  const apps = await sql.query<{ app: string; connection_id: string | null }>(`select app, connection_id from xodo_apps where xodo_id = $1 order by app`, [xodo.id]);
  assert.deepEqual(apps, [{ app: "calendar", connection_id: googleA }, { app: "gmail", connection_id: null }]);

  await assert.rejects(updateXodo(sql, llm, a.agencyId, xodo.id, { apps: [{ app: "gmail", connection_id: googleB }] }), /não é desta agência/);
  await assert.rejects(updateXodo(sql, llm, a.agencyId, xodo.id, { apps: [{ app: "gmail", connection_id: slackA }] }), /outro app/);
  await updateXodo(sql, llm, a.agencyId, xodo.id, { apps: [{ app: "slack", connection_id: slackA }] });
  assert.deepEqual((await sql.query(`select app from xodo_apps where xodo_id = $1`, [xodo.id])).map((r) => r.app), ["slack"]);
});

test("chave de IA é conferida no provedor ao guardar: recusada não fica; provedor fora do ar não impede", async () => {
  const { agencyId, ownerId } = await seedAgency(sql, "Agência Chaves");
  const calls: { url: string; headers: Headers }[] = [];
  const http = (status: number | "down") =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (status === "down") throw new Error("ECONNRESET");
      return new Response("{}", { status });
    }) as typeof fetch;
  const body = { provider: "anthropic", label: "Principal", api_key: "sk-ant-api03-chave-de-teste" };
  const llm2 = { ...llm, providers: () => [{ id: "anthropic", name: "Anthropic" }, { id: "openai", name: "OpenAI" }] };
  await assert.rejects(createCredential(sql, llm2, agencyId, body, ownerId, MASTER, undefined, http(401)), /recusou essa chave/);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=1");
  assert.equal(calls[0].headers.get("x-api-key"), body.api_key);
  const ok = await createCredential(sql, llm2, agencyId, body, ownerId, MASTER, undefined, http(200));
  assert.deepEqual([ok!.checked, ok!.note], [true, null]);
  const down = await createCredential(sql, llm2, agencyId, { ...body, provider: "openai", api_key: "sk-proj-teste-123" }, ownerId, MASTER, undefined, http("down"));
  assert.equal(down!.checked, false);
  assert.match(down!.note!, /primeiro uso confirma/);
  assert.equal(calls.at(-1)!.headers.get("authorization"), "Bearer sk-proj-teste-123");
  assert.equal((await listCredentials(sql, agencyId)).length, 2, "a recusada não ficou");
});
