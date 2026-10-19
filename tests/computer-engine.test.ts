import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { configureComputer } from "../src/lib/computer/lifecycle";
import { fakeProvider, fakeWorld } from "../src/lib/computer/providers/fake";
import { decideAction, sweep } from "../src/lib/xodos/actions";
import { one, type Sql } from "../src/lib/xodos/db";
import { decideApproval, type ApprovalRule } from "../src/lib/xodos/policy";
import { continueRun, continueSlice, resumeTakeover, startRun, toolsFor, type EngineDeps } from "../src/lib/xodos/runner";
import type { Xodo } from "../src/lib/xodos/types";
import { credentialAad, sealSecret } from "../src/lib/xodos/vault";
import { Clock, createTestDb, FakeModel, seedAgency, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function world(xodoOverrides: Partial<Record<keyof Xodo, unknown>> = { computer_mode: "cloud", computer_files: true }) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const machines = fakeWorld();
  const id = randomUUID();
  await sql.query(`insert into ai_credentials (id, agency_id, provider, label, ciphertext, key_last4, kind) values ($1, $2, 'e2b', 'x', $3, 'abcd', 'sandbox')`, [
    id,
    agencyId,
    await sealSecret("k", credentialAad(agencyId, id), MASTER),
  ]);
  const clock = new Clock(new Date("2026-10-19T12:00:00Z"));
  const computer = { masterKey: MASTER, providers: { e2b: fakeProvider(machines) } };
  await configureComputer({ sql, ...computer }, agencyId, { provider: "e2b", credential_id: id });
  const xodo = await seedXodo(sql, agencyId, xodoOverrides);
  const deps = (model: FakeModel): EngineDeps => ({ ...testDeps(sql, model, clock), computer });
  return { agencyId, ownerId, xodo, deps, clock, machines };
}

test("piso da ferramenta e regra por site na política", () => {
  const allowSite: ApprovalRule[] = [{ effect: "always_allow", match_kind: "site", match_value: "navegador_clicar@business.facebook.com" }];
  const base = { toolName: "navegador_clicar", rules: allowSite, autonomy: "pergunta_no_que_importa" as const };
  assert.deepEqual(decideApproval({ ...base, category: "campanha", site: "business.facebook.com" }), { decision: "allow", source: "always_allow" });
  assert.deepEqual(decideApproval({ ...base, category: "campanha", site: "ads.google.com" }), { decision: "ask", source: "autonomy" });
  // A regra de site não vira regra de categoria por engano.
  assert.equal(decideApproval({ ...base, category: "campanha", site: null }).source, "autonomy");
  // Piso da ferramenta: pergunta mesmo com "sempre permitir" e agindo sozinho.
  assert.deepEqual(
    decideApproval({ ...base, rules: [{ effect: "always_allow", match_kind: "category", match_value: "exclusao" }], category: "exclusao", autonomy: "age_sozinho", floor: ["exclusao"] }),
    { decision: "ask", source: "floor" },
  );
});

test("ferramentas do computador só aparecem com ele ligado e com a parte ligada", async () => {
  const on = await world();
  const names = (await toolsFor(on.deps(new FakeModel([])), on.xodo)).map((t) => t.name);
  assert.ok(names.includes("pedir_controle"));
  const off = await world({ computer_mode: "off", computer_files: true });
  assert.ok(!(await toolsFor(off.deps(new FakeModel([])), off.xodo)).some((t) => t.name === "pedir_controle"));
  const noPart = await world({ computer_mode: "cloud" });
  assert.ok(!(await toolsFor(noPart.deps(new FakeModel([])), noPart.xodo)).some((t) => t.name === "pedir_controle"));
});

test("pedir o controle encerra o turno; ao devolver, o xodó continua com a nota do que aconteceu", async () => {
  const w = await world();
  const model = new FakeModel([
    { toolCalls: [{ id: "c1", name: "pedir_controle", input: { motivo: "Faça o login no Meta Business da Verano" } }] },
    { text: "Obrigado! Já estou no painel." },
  ]);
  const deps = w.deps(model);
  const runId = await startRun(deps, { xodoId: w.xodo.id, agencyId: w.agencyId, trigger: "user", text: "Puxa o relatório do Meta", userId: w.ownerId });
  assert.equal(await continueRun(deps, runId), "waiting_takeover");
  const note = await one<{ text: string }>(sql, `select text from xodo_messages where run_id = $1 and role = 'note'`, [runId]);
  assert.equal(note!.text, "Preciso de você no computador: Faça o login no Meta Business da Verano");
  const notice = await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'takeover_requested'`, [w.agencyId]);
  assert.ok(notice);

  assert.equal(await resumeTakeover(deps, runId, "done"), "completed");
  assert.equal(await resumeTakeover(deps, runId, "done"), null, "só retoma uma vez");
  const last = model.requests.at(-1)!.messages;
  const nota = last.at(-1)!;
  assert.equal(nota.role, "user");
  assert.match(String(nota.content), /A pessoa terminou o que você pediu no computador/);
  assert.equal(last.at(-2)!.role, "toolResult", "o resultado do pedido de controle vem antes da nota");
});

test("'aprovar sempre' não vale para o piso; ação num site vira regra só daquele site", async () => {
  const w = await world();
  const runId = randomUUID();
  await sql.query(`insert into xodo_runs (id, xodo_id, agency_id, trigger, provider, model, status) values ($1, $2, $3, 'user', 'faux', 'faux-1', 'waiting_approval')`, [
    runId,
    w.xodo.id,
    w.agencyId,
  ]);
  const insert = async (tool: string, category: string, reason: string, precondition: unknown) =>
    (await one<{ id: string }>(
      sql,
      `insert into xodo_actions (run_id, xodo_id, agency_id, tool_name, category, tool_call_id, step, call_index, input, input_hash, status, reason, precondition)
       values ($1, $2, $3, $4, $5, $6, 1, 0, '{}', 'h', 'pending', $7, $8::jsonb) returning id`,
      [runId, w.xodo.id, w.agencyId, tool, category, randomUUID(), reason, precondition === null ? null : JSON.stringify(precondition)],
    ))!.id;
  const floorAction = await insert("arquivo_apagar", "exclusao", "floor", null);
  const r1 = await decideAction(w.deps(new FakeModel([])), { actionId: floorAction, agencyId: w.agencyId, userId: w.ownerId, approve: false, scope: "always" });
  assert.equal(r1.alwaysRuleCreated, false);
  const siteAction = await insert("navegador_clicar", "campanha", "autonomy", { site: "business.facebook.com", rotulo: "Publicar" });
  const r2 = await decideAction(w.deps(new FakeModel([])), { actionId: siteAction, agencyId: w.agencyId, userId: w.ownerId, approve: true, scope: "always" });
  assert.equal(r2.alwaysRuleCreated, true);
  const rule = await one<{ match_kind: string; match_value: string }>(sql, `select match_kind, match_value from approval_rules where xodo_id = $1`, [w.xodo.id]);
  assert.deepEqual(rule, { match_kind: "site", match_value: "navegador_clicar@business.facebook.com" });
  // Encerra a execução de mentira para a faxina dos outros testes não retomar.
  await sql.query(`update xodo_runs set status = 'completed' where id = $1`, [runId]);
});

test("execução em fatias: para no prazo, uma chamada continua por vez e o cron pega a que ficou para trás", async () => {
  const w = await world({ computer_mode: "off" });
  const model = new FakeModel([{ text: "Pronto." }]);
  const deps = w.deps(model);
  const runId = await startRun(deps, { xodoId: w.xodo.id, agencyId: w.agencyId, trigger: "user", text: "Oi", userId: w.ownerId });
  assert.equal(await continueRun(deps, runId, { deadline: Date.now() - 1 }), "running");
  const sliced = await one<{ slice_due_at: Date | null; status: string }>(sql, `select slice_due_at, status from xodo_runs where id = $1`, [runId]);
  assert.ok(sliced!.slice_due_at);
  assert.equal(sliced!.status, "running");

  // O cron só pega depois de 1 minuto parado.
  assert.equal((await sweep(deps)).continuedSlices, 0);
  w.clock.advance(2 * 60_000);
  assert.equal((await sweep(deps)).continuedSlices, 1);
  const after = await one<{ status: string; error: string }>(sql, `select status, error from xodo_runs where id = $1`, [runId]);
  assert.equal(after!.status, "completed", after!.error);
  assert.equal(await continueSlice(deps, runId), null, "fatia já continuada não roda de novo");
});

test("mensagem no chat enquanto o xodó espera retoma com o texto; esquecida por um dia, segue sem", async () => {
  const w = await world();
  const model = new FakeModel([
    { toolCalls: [{ id: "c1", name: "pedir_controle", input: { motivo: "Resolva o captcha" } }] },
    { text: "Valeu, segui daqui." },
    { toolCalls: [{ id: "c2", name: "pedir_controle", input: { motivo: "Faça o login" } }] },
    { text: "Sigo sem o login." },
  ]);
  const deps = w.deps(model);
  const { takeoverDoneByMessage, withEngine } = await import("../src/lib/computer/control");
  const machines = withEngine({ sql, ...deps.computer! }, deps);

  const first = await startRun(deps, { xodoId: w.xodo.id, agencyId: w.agencyId, trigger: "user", text: "Entra no painel", userId: w.ownerId });
  assert.equal(await continueRun(deps, first), "waiting_takeover");
  assert.equal(await takeoverDoneByMessage(machines, first, w.ownerId, "pronto, resolvi"), true);
  const status = await one<{ status: string }>(sql, `select status from xodo_runs where id = $1`, [first]);
  assert.equal(status!.status, "completed");
  assert.match(String(model.requests.at(-1)!.messages.at(-1)!.content), /Mensagem da pessoa: pronto, resolvi/);
  const saved = await one(sql, `select 1 from xodo_messages where run_id = $1 and role = 'user' and text = 'pronto, resolvi'`, [first]);
  assert.ok(saved, "a mensagem aparece na conversa");

  const second = await startRun(deps, { xodoId: w.xodo.id, agencyId: w.agencyId, trigger: "user", text: "Agora o outro", userId: w.ownerId });
  assert.equal(await continueRun(deps, second), "waiting_takeover");
  w.clock.advance(23 * 3_600_000);
  assert.equal((await sweep(deps)).expiredTakeovers, 0);
  w.clock.advance(2 * 3_600_000);
  assert.ok((await sweep(deps)).expiredTakeovers >= 1);
  const after = await one<{ status: string }>(sql, `select status from xodo_runs where id = $1`, [second]);
  assert.equal(after!.status, "completed");
  assert.match(String(model.requests.at(-1)!.messages.at(-1)!.content), /Ninguém assumiu o computador a tempo/);
});
