import assert from "node:assert/strict";
import { before, test } from "node:test";
import { decideAction, sweep } from "../src/xodos/actions";
import { num, one, type Sql } from "../src/xodos/db";
import { APPROVAL_TTL_MS, continueRun, MAX_STEPS, resumeRun, startRun } from "../src/xodos/runner";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFilesRoot } from "../src/local/files";
import { Clock, createTestDb, FakeModel, seedAgency, seedFx, seedXodo, testDeps } from "./helpers";

let sql: Sql;
let ROOT: string;
before(async () => {
  ({ sql } = await createTestDb());
  await seedFx(sql);
  ROOT = mkdtempSync(path.join(tmpdir(), "xodos-pasta-"));
  await setFilesRoot(ROOT);
});

/** Um arquivo novo na pasta dos xodós, com nome único por teste. */
function arquivo(nome: string, conteudo = "oi") {
  const rel = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${nome}`;
  writeFileSync(path.join(ROOT, rel), conteudo);
  return rel;
}

async function setup(overrides = {}) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, overrides);
  return { agencyId, ownerId, xodo };
}

async function ask(deps: ReturnType<typeof testDeps>, xodo: { id: string; agency_id: string }, text: string, userId: string) {
  const runId = await startRun(deps, { xodoId: xodo.id, agencyId: xodo.agency_id, trigger: "user", text, userId });
  return { runId, status: await continueRun(deps, runId) };
}

const messages = (xodoId: string) =>
  sql.query<{ role: string; text: string }>(`select role, text from xodo_messages where xodo_id = $1 order by id`, [xodoId]);
const actions = (runId: string) =>
  sql.query<{ id: string; tool_name: string; status: string; result: { data?: unknown; error?: string } | null }>(
    `select id, tool_name, status, result from xodo_actions where run_id = $1 order by step, call_index`,
    [runId],
  );

test("responde, registra o gasto em dólar e em reais e mostra a conversa", async () => {
  const { xodo, ownerId } = await setup();
  const model = new FakeModel([{ text: "Oi! Como posso ajudar?" }]);
  const deps = testDeps(sql, model);
  const { runId, status } = await ask(deps, xodo, "Bom dia", ownerId);

  assert.equal(status, "completed");
  assert.deepEqual(await messages(xodo.id), [
    { role: "user", text: "Bom dia" },
    { role: "assistant", text: "Oi! Como posso ajudar?" },
  ]);
  // O modelo recebeu a persona e a mensagem.
  assert.match(model.requests[0].system, /Você é Pipoca/);
  assert.match(model.requests[0].system, /pergunto antes de enviar, pagar ou apagar/);
  // O custo vem do catálogo (US$ 2 e US$ 10 por milhão de tokens) e é convertido pela cotação (R$ 5,50).
  const usage = await one(
    sql,
    `select cost_usd, cost_brl, usd_brl, cost_source, input_tokens, output_tokens, model, attempt, error from ai_usage where run_id = $1`,
    [runId],
  );
  const expectedUsd = (num(usage!.input_tokens) * 2 + num(usage!.output_tokens) * 10) / 1_000_000;
  assert.ok(num(usage!.input_tokens) > 0);
  assert.equal(num(usage!.cost_usd), Math.round(expectedUsd * 1e6) / 1e6);
  assert.equal(num(usage!.usd_brl), 5.5);
  assert.equal(num(usage!.cost_brl), Math.round(num(usage!.cost_usd) * 5.5 * 1e4) / 1e4);
  assert.deepEqual([usage!.cost_source, usage!.model, usage!.attempt, usage!.error], ["catalog", "faux-1", 0, null]);
  const day = await one(sql, `select spent_brl, reserved_brl from xodo_budget_days where xodo_id = $1`, [xodo.id]);
  assert.equal(num(day!.spent_brl), num(usage!.cost_brl));
  assert.equal(num(day!.reserved_brl), 0);
});

test("ferramenta de leitura roda direto e devolve o resultado ao modelo", async () => {
  const { xodo, ownerId } = await setup();
  const nome = arquivo("notas.txt", "lista de compras");
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "listar_arquivos", input: {} }] }, { text: "Achei as notas." }]);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "O que tem na pasta?", ownerId);

  assert.equal(status, "completed");
  const [result] = model.lastToolResults();
  assert.equal(result.isError, false);
  const data = JSON.parse(result.content);
  assert.ok(data.itens.some((i: { nome: string; tipo: string }) => i.nome === nome && i.tipo === "arquivo"));
  assert.deepEqual((await actions(runId)).map((a) => [a.tool_name, a.status]), [["listar_arquivos", "executed"]]);
});

test("apagar espera aprovação; aprovado, executa o pedido guardado uma vez e retoma", async () => {
  const { xodo, ownerId } = await setup();
  const nome = arquivo("velho.txt");
  const model = new FakeModel([
    { text: "Vou ver a pasta.", toolCalls: [{ id: "t1", name: "listar_arquivos", input: {} }] },
    { toolCalls: [{ id: "t2", name: "apagar_arquivo", input: { caminho: nome } }] },
    { text: "Mandei para a lixeira." },
  ]);
  const deps = testDeps(sql, model);
  const { runId, status } = await ask(deps, xodo, "Apaga o arquivo velho", ownerId);

  assert.equal(status, "waiting_approval");
  const [list, remove] = await actions(runId);
  assert.equal(list.status, "executed");
  assert.equal(remove.status, "pending");
  assert.ok(existsSync(path.join(ROOT, nome)), "nada foi apagado antes da aprovação");
  const note = (await messages(xodo.id)).at(-1)!;
  assert.equal(note.role, "note");
  assert.match(note.text, /lixeira dos xodós/);
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'approval_pending'`, [xodo.agency_id]));

  const decided = await decideAction(deps, { actionId: remove.id, agencyId: xodo.agency_id, userId: ownerId, approve: true });
  assert.equal(decided.status, "executed");
  assert.ok(!existsSync(path.join(ROOT, nome)), "foi para a lixeira");

  assert.equal(await resumeRun(deps, runId), "completed");
  assert.deepEqual(model.lastToolResults().map((r) => r.isError), [false]);
  assert.equal((await messages(xodo.id)).at(-1)!.text, "Mandei para a lixeira.");
  // Retomar de novo não faz nada.
  assert.equal(await resumeRun(deps, runId), null);
});

test("a mesma aprovação não executa duas vezes, nem com cliques simultâneos", async () => {
  const { xodo, ownerId, agencyId } = await setup();
  await sql.query(
    `insert into approval_rules (agency_id, effect, match_kind, match_value) values ($1, 'require_approval', 'tool', 'me_avisar')`,
    [agencyId],
  );
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "me_avisar", input: { titulo: "Bom dia" } }] }, { text: "Avisei." }]);
  const deps = testDeps(sql, model);
  const { runId, status } = await ask(deps, xodo, "Me avisa", ownerId);
  assert.equal(status, "waiting_approval");
  const [action] = await actions(runId);

  const outcomes = await Promise.allSettled(
    [1, 2, 3].map(() => decideAction(deps, { actionId: action.id, agencyId, userId: ownerId, approve: true })),
  );
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const sent = await sql.query(`select 1 from notifications where agency_id = $1 and kind = 'xodo_message'`, [agencyId]);
  assert.equal(sent.length, 1);
  await assert.rejects(decideAction(deps, { actionId: action.id, agencyId, userId: ownerId, approve: false }), /já foi decidido/);
});

test("negado: nada roda e o modelo fica sabendo do motivo", async () => {
  const { xodo, ownerId } = await setup();
  const nome = arquivo("guardar.txt");
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "apagar_arquivo", input: { caminho: nome } }] }, { text: "Ok, não apaguei." }]);
  const deps = testDeps(sql, model);
  const { runId } = await ask(deps, xodo, "Apaga", ownerId);
  const [action] = await actions(runId);

  await decideAction(deps, { actionId: action.id, agencyId: xodo.agency_id, userId: ownerId, approve: false, reason: "ainda preciso dele" });
  assert.equal(await resumeRun(deps, runId), "completed");
  const [result] = model.lastToolResults();
  assert.equal(result.isError, true);
  assert.match(result.content, /negou.*ainda preciso dele/);
  assert.ok(existsSync(path.join(ROOT, nome)));
});

test("pedido vencido não pode ser aprovado; o cron vence e retoma a execução", async () => {
  // Banco próprio: o cron retoma qualquer execução pronta, inclusive as deixadas pelos outros testes.
  const shared = sql;
  ({ sql } = await createTestDb());
  try {
    await expiryScenario();
  } finally {
    sql = shared;
  }
});

async function expiryScenario() {
  const { xodo, ownerId } = await setup();
  const nome = arquivo("expira.txt");
  const clock = new Clock();
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "apagar_arquivo", input: { caminho: nome } }] }, { text: "Ninguém respondeu, deixei o arquivo." }]);
  const deps = testDeps(sql, model, clock);
  const { runId } = await ask(deps, xodo, "Apaga", ownerId);
  const [action] = await actions(runId);

  clock.advance(APPROVAL_TTL_MS + 1000);
  await assert.rejects(decideAction(deps, { actionId: action.id, agencyId: xodo.agency_id, userId: ownerId, approve: true }), /expirou/);
  assert.equal((await actions(runId))[0].status, "expired");

  const result = await sweep(deps);
  assert.equal(result.resumedRuns, 1);
  assert.equal((await one<{ status: string }>(sql, `select status from xodo_runs where id = $1`, [runId]))!.status, "completed");
  assert.match(model.lastToolResults()[0].content, /expirou/);
  assert.ok(existsSync(path.join(ROOT, nome)));
}

test("aprovar sempre cria a regra, e a de exigir aprovação continua vencendo", async () => {
  const { xodo, ownerId, agencyId } = await setup();
  await sql.query(
    `insert into approval_rules (agency_id, xodo_id, effect, match_kind, match_value) values ($1, $2, 'require_approval', 'tool', 'lembrar')`,
    [agencyId, xodo.id],
  );
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "lembrar", input: { texto: "Prefiro resumos curtos de manhã.", motivo: "teste" } }] },
    { text: "ok" },
  ]);
  const deps = testDeps(sql, model);
  const { runId } = await ask(deps, xodo, "Anota", ownerId);
  const [action] = await actions(runId);
  const result = await decideAction(deps, { actionId: action.id, agencyId, userId: ownerId, approve: true, scope: "always" });
  assert.equal(result.alwaysRuleCreated, true);
  await resumeRun(deps, runId);
  const rules = await sql.query<{ match_value: string; effect: string }>(
    `select match_value, effect from approval_rules where xodo_id = $1 order by created_at`,
    [xodo.id],
  );
  assert.deepEqual(rules.map((r) => [r.match_value, r.effect]), [
    ["lembrar", "require_approval"],
    ["lembrar", "always_allow"],
  ]);
  // Com as duas regras, lembrar continua pedindo aprovação.
  const model2 = new FakeModel([{ toolCalls: [{ id: "t1", name: "lembrar", input: { texto: "Outra nota.", motivo: "teste" } }] }]);
  const second = await ask(testDeps(sql, model2), xodo, "Anota de novo", ownerId);
  assert.equal(second.status, "waiting_approval");
});

test("entrada inválida e ferramenta desligada viram erro para o modelo, sem executar nada", async () => {
  const { xodo, ownerId } = await setup({ name: "Kiki" });
  await sql.query(`insert into xodo_tools (xodo_id, agency_id, tool_name) values ($1, $2, 'escrever_arquivo')`, [xodo.id, xodo.agency_id]);
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "listar_arquivos", input: { pasta: 123 } },
        { id: "t2", name: "escrever_arquivo", input: { caminho: "a.md", conteudo: "x" } },
        { id: "t3", name: "apagar_tudo", input: {} },
      ],
    },
    { text: "Desculpe." },
  ]);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Faz algo", ownerId);
  assert.equal(status, "completed");
  const results = model.lastToolResults();
  assert.deepEqual(results.map((r) => [r.id, r.isError]), [["t1", true], ["t2", true], ["t3", true]]);
  assert.match(results[0].content, /Entrada inválida/);
  assert.match(results[1].content, /indisponível/, "escrever_arquivo foi desligada para este xodó");
  assert.deepEqual((await actions(runId)).map((a) => a.status), ["failed", "failed", "failed"]);
  // A ferramenta desligada nem é oferecida ao modelo; as outras continuam.
  const offered = model.requests[0].tools.map((t) => t.name);
  assert.ok(!offered.includes("escrever_arquivo"));
  assert.ok(offered.includes("listar_arquivos"));
  assert.ok(!existsSync(path.join(ROOT, "a.md")));
});

test("quem sempre pergunta espera aprovação até para criar um arquivo", async () => {
  const { xodo, ownerId } = await setup({ name: "Lua", autonomy: "sempre_pergunta" });
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "listar_arquivos", input: {} },
        { id: "t2", name: "escrever_arquivo", input: { caminho: "resumo-lua.md", conteudo: "# Resumo" } },
      ],
    },
  ]);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Faz o resumo", ownerId);
  assert.equal(status, "waiting_approval");
  assert.deepEqual((await actions(runId)).map((a) => [a.tool_name, a.status]), [
    ["listar_arquivos", "executed"],
    ["escrever_arquivo", "pending"],
  ]);
  assert.match(model.requests[0].system, /te pergunto antes de qualquer coisa/);
});

test("pedido alterado no banco depois de criado não é executado", async () => {
  const { xodo, ownerId, agencyId } = await setup();
  await sql.query(`insert into approval_rules (agency_id, effect, match_kind, match_value) values ($1, 'require_approval', 'category', 'equipe')`, [agencyId]);
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "me_avisar", input: { titulo: "Oi" } }] }, { text: "ok" }]);
  const deps = testDeps(sql, model);
  const { runId } = await ask(deps, xodo, "Avisa", ownerId);
  const [action] = await actions(runId);
  await sql.query(`update xodo_actions set input = '{"titulo":"Mensagem trocada","mensagem":""}'::jsonb where id = $1`, [action.id]);
  const result = await decideAction(deps, { actionId: action.id, agencyId, userId: ownerId, approve: true });
  assert.equal(result.status, "failed");
  assert.equal((await sql.query(`select 1 from notifications where agency_id = $1 and kind = 'xodo_message'`, [agencyId])).length, 0);
});

test("teto do dia, quando existe, pausa o xodó antes de chamar o modelo", async () => {
  const { xodo, ownerId } = await setup({ daily_budget_brl: 0.01 });
  const model = new FakeModel([]);
  const { status } = await ask(testDeps(sql, model), xodo, "Oi", ownerId);
  assert.equal(status, "paused_budget");
  assert.equal(model.requests.length, 0);
  assert.match((await messages(xodo.id)).at(-1)!.text, /teto de hoje/);
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'budget_capped'`, [xodo.agency_id]));
});

test("recusa de todos os modelos encerra como recusada", async () => {
  const { xodo, ownerId } = await setup();
  const model = new FakeModel([{ refusal: true }]);
  assert.equal((await ask(testDeps(sql, model), xodo, "pedido proibido", ownerId)).status, "refused");
});

async function withBackup() {
  const ctx = await setup();
  const [cred] = await sql.query<{ id: string }>(`select credential_id as id from xodos where id = $1`, [ctx.xodo.id]);
  await sql.query(
    `insert into xodo_models (xodo_id, agency_id, position, provider, model, credential_id) values ($1, $2, 1, 'faux', 'faux-2', $3)`,
    [ctx.xodo.id, ctx.agencyId, cred.id],
  );
  return ctx;
}

test("se o modelo principal cai, o reserva assume no meio da tarefa e continua até o fim", async () => {
  const { xodo, ownerId } = await withBackup();
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "listar_arquivos", input: {} }] }, // principal, passo 1
    { error: "503 overloaded" }, // principal falha no passo 2
    { text: "Feito pelo reserva." }, // reserva assume
  ]);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Lista os clientes", ownerId);
  assert.equal(status, "completed");
  assert.deepEqual(model.requests.map((r) => r.model), ["faux-1", "faux-1", "faux-2"]);
  // O reserva recebeu a conversa inteira, inclusive a ferramenta que o principal chamou.
  assert.equal(model.lastToolResults()[0].name, "listar_arquivos");
  const attempts = await sql.query<{ attempt: number; model: string; error: string | null }>(
    `select attempt, model, error from ai_usage where run_id = $1 order by id`,
    [runId],
  );
  assert.deepEqual(attempts.map((a) => [a.attempt, a.model, a.error]), [
    [0, "faux-1", null],
    [0, "faux-1", "503 overloaded"],
    [1, "faux-2", null],
  ]);
  assert.equal((await messages(xodo.id)).at(-1)!.text, "Feito pelo reserva.");
});

test("depois que o reserva assume, ele segue nos próximos passos da mesma tarefa", async () => {
  const { xodo, ownerId } = await withBackup();
  const model = new FakeModel([
    { refusal: true }, // principal recusa
    { toolCalls: [{ id: "t1", name: "listar_arquivos", input: {} }] }, // reserva
    { text: "ok" }, // reserva de novo, sem voltar ao principal
  ]);
  const { status } = await ask(testDeps(sql, model), xodo, "Lista", ownerId);
  assert.equal(status, "completed");
  assert.deepEqual(model.requests.map((r) => r.model), ["faux-1", "faux-2", "faux-2"]);
});

test("se todos os modelos falham, a tarefa falha com uma mensagem clara", async () => {
  const { xodo, ownerId } = await withBackup();
  const model = new FakeModel([{ error: "401 invalid x-api-key" }, { error: "429 rate limit" }]);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Oi", ownerId);
  assert.equal(status, "failed");
  const run = await one<{ error: string }>(sql, `select error from xodo_runs where id = $1`, [runId]);
  assert.match(run!.error, /limitou as chamadas/);
});

test("modelo de reserva com chave revogada é pulado", async () => {
  const { xodo, ownerId } = await withBackup();
  await sql.query(`update ai_credentials set revoked_at = now() where id = $1`, [xodo.credential_id]);
  const model = new FakeModel([{ text: "nenhum dos dois" }]);
  // As duas posições usam a mesma chave revogada: nada é chamado.
  await assert.rejects(ask(testDeps(sql, model), xodo, "Oi", ownerId), /não tem um modelo utilizável/);
  assert.equal(model.requests.length, 0);
});

test("limite de passos encerra a execução", async () => {
  const { xodo, ownerId } = await setup();
  const loop = Array.from({ length: MAX_STEPS }, (_, i) => ({ toolCalls: [{ id: `t${i}`, name: "listar_arquivos", input: {} }] }));
  const model = new FakeModel(loop);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Repete", ownerId);
  assert.equal(status, "completed");
  assert.equal(model.requests.length, MAX_STEPS);
  assert.equal((await one<{ steps: number }>(sql, `select steps from xodo_runs where id = $1`, [runId]))!.steps, MAX_STEPS);
  assert.match((await messages(xodo.id)).at(-1)!.text, /limite de passos/);
});

test("xodó pausado, sem modelo utilizável ou ocupado não começa", async () => {
  const { xodo, ownerId } = await setup();
  const deps = testDeps(sql, new FakeModel([]));
  const start = (x: { id: string; agency_id: string }) =>
    startRun(deps, { xodoId: x.id, agencyId: x.agency_id, trigger: "user", text: "Oi", userId: ownerId });

  await startRun(deps, { xodoId: xodo.id, agencyId: xodo.agency_id, trigger: "user", text: "Primeiro", userId: ownerId });
  await assert.rejects(start(xodo), /ainda está trabalhando/);

  const paused = await seedXodo(sql, xodo.agency_id, { name: "Pausado", status: "paused" });
  await assert.rejects(start(paused), /pausado/);
  const unknown = await seedXodo(sql, xodo.agency_id, { name: "Modelo sumiu", model: "modelo-x" });
  await assert.rejects(start(unknown), /não existe no catálogo/);
  // Chave revogada: falha antes de criar a execução e não bloqueia o xodó.
  const revoked = await seedXodo(sql, xodo.agency_id, { name: "Sem chave" });
  await sql.query(`update ai_credentials set revoked_at = now() where id = $1`, [revoked.credential_id]);
  await assert.rejects(start(revoked), /revogada/);
  assert.equal((await sql.query(`select 1 from xodo_runs where xodo_id = $1`, [revoked.id])).length, 0);
  // Xodó de outra agência não é encontrado.
  const other = await seedAgency(sql, "Outra");
  await assert.rejects(startRun(deps, { xodoId: xodo.id, agencyId: other.agencyId, trigger: "user", text: "Oi" }), /não encontrado/);
});
