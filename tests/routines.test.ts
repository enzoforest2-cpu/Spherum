import assert from "node:assert/strict";
import { before, test } from "node:test";
import { one, type Sql } from "../src/xodos/db";
import { createRoutine, nextRunAt, runDueRoutines, validateCron } from "../src/xodos/routines";
import { Clock, createTestDb, FakeModel, seedAgency, seedFx, seedXodo, testDeps } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
  await seedFx(sql);
});

test("agenda no fuso da agência e recusa mais de uma vez por hora", () => {
  // Segunda, 8h em São Paulo = 11h UTC.
  const next = nextRunAt("0 8 * * 1", "America/Sao_Paulo", new Date("2026-10-19T12:00:00Z"));
  assert.equal(next?.toISOString(), "2026-10-26T11:00:00.000Z");
  validateCron("0 8 * * 1", "America/Sao_Paulo");
  validateCron("0 * * * *", "UTC");
  assert.throws(() => validateCron("*/5 * * * *", "UTC"), /uma vez por hora/);
  assert.throws(() => validateCron("isso não é cron", "UTC"), /inválida/);
  assert.throws(() => validateCron("0 8 * * 1", "Lua/Base"), /inválida/);
});

test("roda a rotina vencida uma vez, guarda o resumo e agenda a próxima", async () => {
  const clock = new Clock(new Date("2026-10-19T10:00:00Z"));
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId);
  const routine = await createRoutine(
    sql,
    { agencyId, xodoId: xodo.id, name: "Relatório semanal", prompt: "Monte o resumo da semana.", cron: "0 8 * * 1" },
    clock.now(),
  );
  assert.equal(new Date(routine.next_run_at).toISOString(), "2026-10-19T11:00:00.000Z");

  const model = new FakeModel([{ text: "Semana fechada: 3 clientes acima da meta." }, { text: "Semana 2: tudo certo." }]);
  const deps = testDeps(sql, model, clock);

  assert.deepEqual(await runDueRoutines(deps), [], "ainda não venceu");
  clock.advance(90 * 60 * 1000);
  const [first] = await runDueRoutines(deps);
  assert.equal(first.status, "completed");
  assert.deepEqual(await runDueRoutines(deps), [], "não roda de novo na mesma janela");

  const row = await one<{ last_summary: string; next_run_at: Date; locked_until: Date | null; last_run_id: string }>(
    sql,
    `select last_summary, next_run_at, locked_until, last_run_id from xodo_routines where id = $1`,
    [routine.id],
  );
  assert.equal(row!.last_summary, "Semana fechada: 3 clientes acima da meta.");
  assert.equal(new Date(row!.next_run_at).toISOString(), "2026-10-26T11:00:00.000Z");
  assert.equal(row!.locked_until, null);
  // Rotina roda sem mensagem visível do usuário; o pedido vai direto ao modelo.
  const run = await one<{ trigger: string }>(sql, `select trigger from xodo_runs where id = $1`, [row!.last_run_id]);
  assert.equal(run!.trigger, "routine");
  assert.match(model.requests[0].system, /rotina agendada "Relatório semanal"/);

  // Na semana seguinte, o resumo anterior entra no contexto (continuidade).
  clock.advance(7 * 24 * 60 * 60 * 1000);
  await runDueRoutines(deps);
  assert.match(model.requests[1].system, /3 clientes acima da meta/);
});

test("rotina de xodó pausado avisa a equipe e agenda a próxima", async () => {
  const clock = new Clock(new Date("2026-10-19T10:00:00Z"));
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, { status: "paused" });
  const routine = await createRoutine(sql, { agencyId, xodoId: xodo.id, name: "Diária", prompt: "Olhe os alertas.", cron: "0 9 * * *" }, clock.now());
  clock.advance(4 * 60 * 60 * 1000);
  const [result] = await runDueRoutines(testDeps(sql, new FakeModel([]), clock));
  assert.equal(result.status, "failed");
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'routine_failed'`, [agencyId]));
  const row = await one<{ next_run_at: Date }>(sql, `select next_run_at from xodo_routines where id = $1`, [routine.id]);
  assert.equal(new Date(row!.next_run_at).toISOString(), "2026-10-20T12:00:00.000Z");
});

test("não cria rotina para xodó de outra agência", async () => {
  const a = await seedAgency(sql, "A");
  const b = await seedAgency(sql, "B");
  const xodo = await seedXodo(sql, a.agencyId);
  await assert.rejects(
    createRoutine(sql, { agencyId: b.agencyId, xodoId: xodo.id, name: "x", prompt: "y", cron: "0 8 * * 1" }),
    /não encontrado/,
  );
});

test("rotina usa o modelo escolhido para rotinas; se ele falhar, cai no principal", async () => {
  const clock = new Clock(new Date("2026-10-19T10:00:00Z"));
  const { agencyId } = await seedAgency(sql);
  const base = await seedXodo(sql, agencyId, { name: "Roteado" });
  await sql.query(
    `update xodos set routine_provider = 'faux', routine_model = 'faux-2', routine_credential_id = credential_id where id = $1`,
    [base.id],
  );
  await createRoutine(sql, { agencyId, xodoId: base.id, name: "Diária", prompt: "Resumo.", cron: "0 8 * * *" }, clock.now());
  clock.advance(2 * 60 * 60 * 1000);
  const model = new FakeModel([{ text: "feito pelo modelo das rotinas" }, { error: "503 overloaded" }, { text: "feito pelo principal" }]);
  const deps = testDeps(sql, model, clock);
  await runDueRoutines(deps);
  assert.deepEqual(model.requests.map((r) => r.model), ["faux-2"]);
  // No dia seguinte o modelo das rotinas cai e o principal assume.
  clock.advance(24 * 60 * 60 * 1000);
  await runDueRoutines(deps);
  assert.deepEqual(model.requests.map((r) => r.model), ["faux-2", "faux-2", "faux-1"]);
});
