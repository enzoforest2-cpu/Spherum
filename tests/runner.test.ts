import assert from "node:assert/strict";
import { before, test } from "node:test";
import { decideAction, sweep } from "../src/lib/xodos/actions";
import { num, one, type Sql } from "../src/lib/xodos/db";
import { APPROVAL_TTL_MS, continueRun, MAX_STEPS, resumeRun, startRun, XodoError } from "../src/lib/xodos/runner";
import { Clock, createTestDb, FakeModel, seedAgency, seedClient, seedMetrics, seedXodo, testDeps } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function setup(overrides = {}) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const clientId = await seedClient(sql, agencyId, "Loja Verano");
  const xodo = await seedXodo(sql, agencyId, overrides);
  return { agencyId, ownerId, clientId, xodo };
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

test("responde, registra o gasto e mostra a conversa", async () => {
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
  assert.match(model.requests[0].system, /Loja Verano/);
  // 1000 de input a US$ 2/Mtok + 200 de output a US$ 10/Mtok = 0,004
  const usage = await one(sql, `select cost_usd, call_id, model from ai_usage where run_id = $1`, [runId]);
  assert.equal(num(usage!.cost_usd), 0.004);
  assert.equal(usage!.model, "claude-sonnet-5-5");
  const budget = await one(sql, `select spent_usd, reserved_usd from xodo_budget_days where xodo_id = $1`, [xodo.id]);
  assert.equal(num(budget!.spent_usd), 0.004);
  assert.equal(num(budget!.reserved_usd), 0);
});

test("ferramenta de leitura roda direto e devolve os números ao modelo", async () => {
  const { xodo, ownerId, agencyId, clientId } = await setup();
  await seedMetrics(sql, agencyId, clientId, [
    { day: "2026-10-01", spend_cents: 10_000, impressions: 10_000, clicks: 200, leads: 10, revenue_cents: 50_000 },
    { day: "2026-10-02", spend_cents: 30_000, impressions: 30_000, clicks: 400, leads: 10, revenue_cents: 70_000 },
    { day: "2026-09-15", spend_cents: 99_999, leads: 1 },
  ]);
  const model = new FakeModel([
    {
      toolCalls: [{ id: "t1", name: "consultar_metricas", input: { client_id: clientId, inicio: "2026-10-01", fim: "2026-10-31" } }],
    },
    { text: "CPL de R$ 20,00 em outubro." },
  ]);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Como está o CPL da Verano?", ownerId);

  assert.equal(status, "completed");
  const [result] = model.lastToolResults();
  assert.equal(result.isError, false);
  const data = JSON.parse(result.content);
  assert.deepEqual(data.linhas[0], {
    investimento_brl: 400,
    receita_brl: 1200,
    impressoes: 40_000,
    cliques: 600,
    leads: 20,
    conversoes: 0,
    ctr_pct: 1.5,
    cpc_brl: 0.67,
    cpl_brl: 20,
    roas: 3,
  });
  assert.deepEqual((await actions(runId)).map((a) => [a.tool_name, a.status]), [["consultar_metricas", "executed"]]);
});

test("publicar para o cliente espera aprovação; aprovado, executa o pedido guardado uma vez e retoma", async () => {
  const { xodo, ownerId, clientId } = await setup();
  const model = new FakeModel([
    {
      text: "Vou montar o rascunho.",
      toolCalls: [
        {
          id: "t1",
          name: "criar_rascunho_relatorio",
          input: { client_id: clientId, inicio: "2026-10-01", fim: "2026-10-31", titulo: "Outubro", conteudo_md: "# Outubro" },
        },
      ],
    },
    (req) => {
      const history = req.history as { role: string; results?: { content: string }[] }[];
      const reportId = JSON.parse(history[history.length - 1].results![0].content).report_id;
      return { toolCalls: [{ id: "t2", name: "publicar_relatorio", input: { report_id: reportId } }] };
    },
    { text: "Publicado no portal da Loja Verano." },
  ]);
  const deps = testDeps(sql, model);
  const { runId, status } = await ask(deps, xodo, "Fecha o relatório de outubro da Verano", ownerId);

  assert.equal(status, "waiting_approval");
  const [draft, publish] = await actions(runId);
  assert.equal(draft.status, "executed");
  assert.equal(publish.status, "pending");
  const report = await one<{ status: string }>(sql, `select status from reports where created_by_xodo = $1`, [xodo.id]);
  assert.equal(report!.status, "draft", "nada foi publicado antes da aprovação");
  const note = (await messages(xodo.id)).at(-1)!;
  assert.equal(note.role, "note");
  assert.match(note.text, /publicar um relatório no portal do cliente/);
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'approval_pending'`, [xodo.agency_id]));

  const decided = await decideAction(deps, { actionId: publish.id, agencyId: xodo.agency_id, userId: ownerId, approve: true });
  assert.equal(decided.status, "executed");
  assert.equal((await one<{ status: string }>(sql, `select status from reports where created_by_xodo = $1`, [xodo.id]))!.status, "published");

  assert.equal(await resumeRun(deps, runId), "completed");
  assert.deepEqual(model.lastToolResults().map((r) => r.isError), [false]);
  assert.equal((await messages(xodo.id)).at(-1)!.text, "Publicado no portal da Loja Verano.");
  // Retomar de novo não faz nada.
  assert.equal(await resumeRun(deps, runId), null);
});

test("a mesma aprovação não executa duas vezes, nem com cliques simultâneos", async () => {
  const { xodo, ownerId, agencyId } = await setup();
  await sql.query(
    `insert into approval_rules (agency_id, effect, match_kind, match_value) values ($1, 'require_approval', 'tool', 'avisar_equipe')`,
    [agencyId],
  );
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "avisar_equipe", input: { titulo: "Bom dia" } }] }, { text: "Avisei." }]);
  const deps = testDeps(sql, model);
  const { runId, status } = await ask(deps, xodo, "Avisa a equipe", ownerId);
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
  const { xodo, ownerId, clientId } = await setup();
  const reportId = (await one<{ id: string }>(
    sql,
    `insert into reports (agency_id, client_id, period_start, period_end, title) values ($1, $2, '2026-10-01', '2026-10-31', 'Out') returning id`,
    [xodo.agency_id, clientId],
  ))!.id;
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "publicar_relatorio", input: { report_id: reportId } }] }, { text: "Ok, não publiquei." }]);
  const deps = testDeps(sql, model);
  const { runId } = await ask(deps, xodo, "Publica", ownerId);
  const [action] = await actions(runId);

  await decideAction(deps, { actionId: action.id, agencyId: xodo.agency_id, userId: ownerId, approve: false, reason: "falta revisar" });
  assert.equal(await resumeRun(deps, runId), "completed");
  const [result] = model.lastToolResults();
  assert.equal(result.isError, true);
  assert.match(result.content, /negou.*falta revisar/);
  assert.equal((await one<{ status: string }>(sql, `select status from reports where id = $1`, [reportId]))!.status, "draft");
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
  const { xodo, ownerId, clientId } = await setup();
  const reportId = (await one<{ id: string }>(
    sql,
    `insert into reports (agency_id, client_id, period_start, period_end, title) values ($1, $2, '2026-10-01', '2026-10-31', 'Out') returning id`,
    [xodo.agency_id, clientId],
  ))!.id;
  const clock = new Clock();
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "publicar_relatorio", input: { report_id: reportId } }] }, { text: "Ninguém respondeu, deixei como rascunho." }]);
  const deps = testDeps(sql, model, clock);
  const { runId } = await ask(deps, xodo, "Publica", ownerId);
  const [action] = await actions(runId);

  clock.advance(APPROVAL_TTL_MS + 1000);
  await assert.rejects(decideAction(deps, { actionId: action.id, agencyId: xodo.agency_id, userId: ownerId, approve: true }), /expirou/);
  assert.equal((await actions(runId))[0].status, "expired");

  const result = await sweep(deps);
  assert.equal(result.resumedRuns, 1);
  assert.equal((await one<{ status: string }>(sql, `select status from xodo_runs where id = $1`, [runId]))!.status, "completed");
  assert.match(model.lastToolResults()[0].content, /expirou/);
  assert.equal((await one<{ status: string }>(sql, `select status from reports where id = $1`, [reportId]))!.status, "draft");
}

test("aprovar sempre cria a regra, menos para o que vai ao cliente", async () => {
  const { xodo, ownerId, agencyId, clientId } = await setup();
  await sql.query(
    `insert into approval_rules (agency_id, xodo_id, effect, match_kind, match_value) values ($1, $2, 'require_approval', 'tool', 'atualizar_memoria')`,
    [agencyId, xodo.id],
  );
  // A regra de exigir vence a de permitir que o "sempre" vai criar.
  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "atualizar_memoria", input: { conteudo: "nota", motivo: "teste" } }] },
    { text: "ok" },
  ]);
  const deps = testDeps(sql, model);
  const { runId } = await ask(deps, xodo, "Anota", ownerId);
  const [action] = await actions(runId);
  const result = await decideAction(deps, { actionId: action.id, agencyId, userId: ownerId, approve: true, scope: "always" });
  assert.equal(result.alwaysRuleCreated, true);

  const reportId = (await one<{ id: string }>(
    sql,
    `insert into reports (agency_id, client_id, period_start, period_end, title) values ($1, $2, '2026-10-01', '2026-10-31', 'Out') returning id`,
    [agencyId, clientId],
  ))!.id;
  await resumeRun(deps, runId);
  const model2 = new FakeModel([{ toolCalls: [{ id: "t1", name: "publicar_relatorio", input: { report_id: reportId } }] }]);
  const deps2 = testDeps(sql, model2);
  const second = await ask(deps2, xodo, "Publica", ownerId);
  const [publish] = await actions(second.runId);
  const r2 = await decideAction(deps2, { actionId: publish.id, agencyId, userId: ownerId, approve: true, scope: "always" });
  assert.equal(r2.alwaysRuleCreated, false);
  const rules = await sql.query<{ match_value: string; effect: string }>(
    `select match_value, effect from approval_rules where xodo_id = $1 order by created_at`,
    [xodo.id],
  );
  assert.deepEqual(rules.map((r) => [r.match_value, r.effect]), [
    ["atualizar_memoria", "require_approval"],
    ["atualizar_memoria", "always_allow"],
  ]);
});

test("um xodó não enxerga clientes de outra agência nem fora da lista dele", async () => {
  const { xodo: xodoA, ownerId, agencyId } = await setup();
  const other = await seedAgency(sql, "Concorrente");
  const otherClient = await seedClient(sql, other.agencyId, "Cliente da concorrente");
  await seedMetrics(sql, other.agencyId, otherClient, [{ day: "2026-10-01", spend_cents: 123 }]);

  const model = new FakeModel([
    { toolCalls: [{ id: "t1", name: "consultar_metricas", input: { client_id: otherClient, inicio: "2026-10-01", fim: "2026-10-31" } }] },
    { text: "Não tenho acesso." },
  ]);
  await ask(testDeps(sql, model), xodoA, "Métricas", ownerId);
  const [result] = model.lastToolResults();
  assert.equal(result.isError, true);
  assert.match(result.content, /fora do alcance/);

  // Escopo "selected": só os clientes da lista.
  const allowed = await seedClient(sql, agencyId, "Academia Pulse");
  const hidden = await seedClient(sql, agencyId, "Moraes Advocacia");
  const scoped = await seedXodo(sql, agencyId, { name: "Bip", client_scope: "selected" });
  await sql.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [scoped.id, allowed, agencyId]);
  const model2 = new FakeModel([{ toolCalls: [{ id: "t1", name: "listar_clientes", input: {} }, { id: "t2", name: "comparar_periodos", input: { client_id: hidden, atual: { inicio: "2026-10-01", fim: "2026-10-31" }, anterior: { inicio: "2026-09-01", fim: "2026-09-30" } } }] }, { text: "ok" }]);
  await ask(testDeps(sql, model2), scoped, "Clientes?", ownerId);
  const [list, compare] = model2.lastToolResults();
  assert.deepEqual(JSON.parse(list.content), [{ id: allowed, nome: "Academia Pulse" }]);
  assert.equal(compare.isError, true);
  assert.doesNotMatch(model2.requests[0].system, /Moraes/);

  // O banco recusa ligar um cliente de outra agência ao xodó.
  await assert.rejects(
    sql.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [scoped.id, otherClient, agencyId]),
    /não pertence/,
  );
});

test("entrada inválida e ferramenta desligada viram erro para o modelo, sem executar nada", async () => {
  const { xodo, ownerId } = await setup({ name: "Kiki" });
  await sql.query(`insert into xodo_tools (xodo_id, agency_id, tool_name) values ($1, $2, 'publicar_relatorio')`, [
    xodo.id,
    xodo.agency_id,
  ]);
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "consultar_metricas", input: { client_id: "nao-e-uuid" } },
        { id: "t2", name: "publicar_relatorio", input: { report_id: "8e0f6c1e-4c39-4b55-9e0e-4f5a7c0f9a11" } },
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
  assert.match(results[1].content, /indisponível/, "publicar_relatorio foi desligada para este xodó");
  assert.deepEqual((await actions(runId)).map((a) => a.status), ["failed", "failed", "failed"]);
  // A ferramenta desligada nem é oferecida ao modelo; as outras continuam.
  const offered = model.requests[0].tools.map((t) => t.name);
  assert.ok(!offered.includes("publicar_relatorio"));
  assert.ok(offered.includes("criar_rascunho_relatorio"));
});

test("quem sempre pergunta espera aprovação até para salvar um rascunho", async () => {
  const { xodo, ownerId, clientId } = await setup({ name: "Lua", autonomy: "sempre_pergunta" });
  const model = new FakeModel([
    {
      toolCalls: [
        { id: "t1", name: "listar_clientes", input: {} },
        {
          id: "t2",
          name: "criar_rascunho_relatorio",
          input: { client_id: clientId, inicio: "2026-10-01", fim: "2026-10-31", titulo: "Out", conteudo_md: "# Out" },
        },
      ],
    },
  ]);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Faz o rascunho", ownerId);
  assert.equal(status, "waiting_approval");
  assert.deepEqual((await actions(runId)).map((a) => [a.tool_name, a.status]), [
    ["listar_clientes", "executed"],
    ["criar_rascunho_relatorio", "pending"],
  ]);
  assert.match(model.requests[0].system, /te pergunto antes de qualquer coisa/);
});

test("pedido alterado no banco depois de criado não é executado", async () => {
  const { xodo, ownerId, agencyId } = await setup();
  await sql.query(`insert into approval_rules (agency_id, effect, match_kind, match_value) values ($1, 'require_approval', 'category', 'equipe')`, [agencyId]);
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "avisar_equipe", input: { titulo: "Oi" } }] }, { text: "ok" }]);
  const deps = testDeps(sql, model);
  const { runId } = await ask(deps, xodo, "Avisa", ownerId);
  const [action] = await actions(runId);
  await sql.query(`update xodo_actions set input = '{"titulo":"Mensagem trocada","mensagem":""}'::jsonb where id = $1`, [action.id]);
  const result = await decideAction(deps, { actionId: action.id, agencyId, userId: ownerId, approve: true });
  assert.equal(result.status, "failed");
  assert.equal((await sql.query(`select 1 from notifications where agency_id = $1 and kind = 'xodo_message'`, [agencyId])).length, 0);
});

test("teto do dia pausa o xodó antes de chamar o modelo", async () => {
  const { xodo, ownerId } = await setup({ daily_budget_usd: 0.01 });
  const model = new FakeModel([]);
  const { status } = await ask(testDeps(sql, model), xodo, "Oi", ownerId);
  assert.equal(status, "paused_budget");
  assert.equal(model.requests.length, 0);
  assert.match((await messages(xodo.id)).at(-1)!.text, /teto de hoje/);
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'budget_capped'`, [xodo.agency_id]));
});

test("recusa do modelo encerra como recusada", async () => {
  const { xodo, ownerId } = await setup();
  const model = new FakeModel([{ text: "", stop: "refusal" }]);
  assert.equal((await ask(testDeps(sql, model), xodo, "pedido proibido", ownerId)).status, "refused");
});

test("limite de passos encerra a execução", async () => {
  const { xodo, ownerId } = await setup();
  const loop = Array.from({ length: MAX_STEPS }, (_, i) => ({ toolCalls: [{ id: `t${i}`, name: "listar_clientes", input: {} }] }));
  const model = new FakeModel(loop);
  const { runId, status } = await ask(testDeps(sql, model), xodo, "Repete", ownerId);
  assert.equal(status, "completed");
  assert.equal(model.requests.length, MAX_STEPS);
  assert.equal((await one<{ steps: number }>(sql, `select steps from xodo_runs where id = $1`, [runId]))!.steps, MAX_STEPS);
  assert.match((await messages(xodo.id)).at(-1)!.text, /limite de passos/);
});

test("xodó pausado, sem preço ou ocupado não começa", async () => {
  const { xodo, ownerId } = await setup();
  const deps = testDeps(sql, new FakeModel([]));
  const start = (x: { id: string; agency_id: string }) =>
    startRun(deps, { xodoId: x.id, agencyId: x.agency_id, trigger: "user", text: "Oi", userId: ownerId });

  await startRun(deps, { xodoId: xodo.id, agencyId: xodo.agency_id, trigger: "user", text: "Primeiro", userId: ownerId });
  await assert.rejects(start(xodo), /ainda está trabalhando/);

  const paused = await seedXodo(sql, xodo.agency_id, { name: "Pausado", status: "paused" });
  await assert.rejects(start(paused), /pausado/);
  const unpriced = await seedXodo(sql, xodo.agency_id, { name: "Sem preço", provider: "openai", model: "modelo-x" });
  await assert.rejects(start(unpriced), /não tem preço/);
  // Chave revogada: falha antes de criar a execução e não bloqueia o xodó.
  const revoked = await seedXodo(sql, xodo.agency_id, { name: "Sem chave" });
  const failing = { ...deps, driverFor: async () => Promise.reject(new XodoError("A chave de API foi revogada", 422)) };
  await assert.rejects(
    startRun(failing, { xodoId: revoked.id, agencyId: revoked.agency_id, trigger: "user", text: "Oi", userId: ownerId }),
    /revogada/,
  );
  assert.equal((await sql.query(`select 1 from xodo_runs where xodo_id = $1`, [revoked.id])).length, 0);
  // Xodó de outra agência não é encontrado.
  const other = await seedAgency(sql, "Outra");
  await assert.rejects(startRun(deps, { xodoId: xodo.id, agencyId: other.agencyId, trigger: "user", text: "Oi" }), /não encontrado/);
});
