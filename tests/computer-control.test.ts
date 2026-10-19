import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import {
  CONTROL_LEASE_MS,
  expireControls,
  hashToken,
  heartbeat,
  release,
  releaseByLink,
  screenUrls,
  takeControl,
  takeoverDoneByMessage,
  withEngine,
  type ControlDeps,
} from "../src/lib/computer/control";
import { configureComputer, ensureRunning, loadComputer, type ComputerDeps } from "../src/lib/computer/lifecycle";
import { createSandboxKey, getComputerState, listEvents, listSandboxKeys, setSiteRules, stopComputer } from "../src/lib/computer/manage";
import { fakeProvider, fakeWorld, type FakeWorld } from "../src/lib/computer/providers/fake";
import { one, type Sql } from "../src/lib/xodos/db";
import { continueRun, startRun } from "../src/lib/xodos/runner";
import type { Xodo } from "../src/lib/xodos/types";
import { credentialAad, openSecret, sealSecret } from "../src/lib/xodos/vault";
import { Clock, createTestDb, FakeModel, seedAgency, seedFx, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
const PROVIDER_KEY = "e2b_chave_da_agencia_1234";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
  await seedFx(sql, "2026-10-19", 5);
});

async function member(agencyId: string, role: "admin" | "member" | "viewer") {
  const id = randomUUID();
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, $3)`, [agencyId, id, role]);
  return id;
}

async function setup(xodoOverrides: Partial<Record<keyof Xodo, unknown>> = { computer_mode: "cloud", computer_files: true }) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const world = fakeWorld();
  const clock = new Clock(new Date("2026-10-19T12:00:00Z"));
  const credential = randomUUID();
  await sql.query(
    `insert into ai_credentials (id, agency_id, provider, label, ciphertext, key_last4, kind) values ($1, $2, 'e2b', 'Máquina', $3, '1234', 'sandbox')`,
    [credential, agencyId, await sealSecret(PROVIDER_KEY, credentialAad(agencyId, credential), MASTER)],
  );
  const computer: ComputerDeps = { sql, now: clock.now, masterKey: MASTER, providers: { e2b: fakeProvider(world) } };
  await configureComputer(computer, agencyId, { provider: "e2b", credential_id: credential });
  const xodo = await seedXodo(sql, agencyId, xodoOverrides);
  const engineFor = (model: FakeModel) => ({ ...testDeps(sql, model, clock), computer: { masterKey: MASTER, providers: computer.providers } });
  const control = (model = new FakeModel([])): ControlDeps => withEngine(computer, engineFor(model));
  return { agencyId, ownerId, world, clock, computer, xodo, engineFor, control };
}

const runScripts = (world: FakeWorld) =>
  world.calls.filter((c) => c.op === "run").map((c) => c.detail as { script: string; user: string });

const tokenOf = (url: string) => decodeURIComponent(url.split("#t=")[1]);

/** Deixa uma execução do xodó esperando a pessoa (pedir_controle com o modelo falso). */
async function waitingRun(s: Awaited<ReturnType<typeof setup>>, model: FakeModel) {
  const engine = s.engineFor(model);
  const runId = await startRun(engine, { xodoId: s.xodo.id, agencyId: s.agencyId, trigger: "user", text: "Puxa o relatório do Meta", userId: s.ownerId });
  assert.equal(await continueRun(engine, runId), "waiting_takeover");
  return runId;
}

const runStatus = async (runId: string) => (await one<{ status: string }>(sql, `select status from xodo_runs where id = $1`, [runId]))!.status;

test("assumir: lease de 15 min, só o hash do token no banco e o token chega à máquina em base64", async () => {
  const s = await setup();
  const grant = await takeControl(s.control(), s.agencyId, s.ownerId);
  assert.match(grant.viewUrl, /^https:\/\/6100-fake-[a-z0-9]+\.fake\.sandbox\/view\.html#t=c-[A-Za-z0-9_-]{43}$/);
  assert.match(grant.terminalUrl, /\/terminal\.html#t=t-/);
  const token = tokenOf(grant.viewUrl).slice(2);
  assert.equal(tokenOf(grant.terminalUrl).slice(2), token);

  const row = (await loadComputer(sql, s.agencyId))!;
  assert.equal(row.control_user_id, s.ownerId);
  assert.equal(row.control_lease_id, grant.leaseId);
  assert.equal(row.control_token_hash, hashToken(token));
  assert.equal(row.control_fence, 1);
  assert.equal(new Date(row.control_expires_at!).getTime() - s.clock.now().getTime(), CONTROL_LEASE_MS);
  // Em lugar nenhum do banco aparece o token em texto.
  const dump = JSON.stringify(await sql.query(`select * from computers`)) + JSON.stringify(await sql.query(`select * from computer_events`));
  assert.ok(!dump.includes(token));

  const scripts = runScripts(s.world);
  const start = scripts.find((c) => c.script.includes("spherum-control-vnc start"))!;
  assert.equal(start.user, "root");
  assert.ok(!start.script.includes(token), "o token não vai cru no comando");
  assert.ok(start.script.includes(`'${Buffer.from(token).toString("base64")}'`), "vai em base64 entre aspas simples");
  assert.match(start.script, /\/run\/spherum\/tokens\/control/);
  assert.match(start.script, /spherum-pty start/);
  const ev = await one(sql, `select 1 from computer_events where agency_id = $1 and kind = 'assumir_controle' and user_id = $2`, [s.agencyId, s.ownerId]);
  assert.ok(ev);
});

test("uma pessoa por vez; viewer não assume; admin toma de outra pessoa e revoga a anterior", async () => {
  const s = await setup();
  const ana = await member(s.agencyId, "member");
  const bia = await member(s.agencyId, "member");
  const adm = await member(s.agencyId, "admin");
  const viewer = await member(s.agencyId, "viewer");
  await assert.rejects(takeControl(s.control(), s.agencyId, viewer), (e: Error & { status?: number }) => e.status === 403);
  await assert.rejects(takeControl(s.control(), s.agencyId, randomUUID()), (e: Error & { status?: number }) => e.status === 404);

  const first = await takeControl(s.control(), s.agencyId, ana);
  await assert.rejects(takeControl(s.control(), s.agencyId, bia), /Outra pessoa/);
  // Membro não devolve o controle de outra pessoa.
  await assert.rejects(release(s.control(), s.agencyId, bia, "done"), (e: Error & { status?: number }) => e.status === 403);

  const taken = await takeControl(s.control(), s.agencyId, adm);
  assert.equal(taken.revokedUserId, ana);
  const row = (await loadComputer(sql, s.agencyId))!;
  assert.equal(row.control_user_id, adm);
  assert.notEqual(row.control_token_hash, hashToken(tokenOf(first.viewUrl).slice(2)));
  // O heartbeat da pessoa revogada não renova mais.
  await assert.rejects(heartbeat(s.control(), s.agencyId, ana, first.leaseId), /não está mais no controle/);
  // A troca derruba quem estava conectado: o VNC de controle é reiniciado.
  const restarts = runScripts(s.world).filter((c) => c.script.includes("spherum-control-vnc stop") && c.script.includes("spherum-control-vnc start"));
  assert.equal(restarts.length, 2);
  const revoked = await one(sql, `select 1 from computer_events where agency_id = $1 and kind = 'controle_revogado' and user_id = $2`, [s.agencyId, ana]);
  assert.ok(revoked);
});

test("renovar até 2 horas; devolver apaga os tokens e mata os processos", async () => {
  const s = await setup();
  const grant = await takeControl(s.control(), s.agencyId, s.ownerId);
  s.clock.advance(10 * 60_000);
  const renewed = await heartbeat(s.control(), s.agencyId, s.ownerId, grant.leaseId);
  assert.equal(new Date(renewed.expiresAt).getTime(), s.clock.now().getTime() + CONTROL_LEASE_MS);
  assert.match(runScripts(s.world).at(-1)!.script, /\/run\/spherum\/expiry\/control/);
  // Renovando a cada 10 minutos: o vencimento nunca passa de 2 horas desde que assumiu.
  for (let i = 0; i < 20; i += 1) {
    s.clock.advance(10 * 60_000);
    if (s.clock.now().getTime() >= new Date("2026-10-19T14:00:00Z").getTime()) break;
    const r = await heartbeat(s.control(), s.agencyId, s.ownerId, grant.leaseId);
    assert.ok(new Date(r.expiresAt).getTime() <= new Date("2026-10-19T14:00:00Z").getTime());
  }
  await assert.rejects(heartbeat(s.control(), s.agencyId, s.ownerId, grant.leaseId), (e: Error & { status?: number }) => e.status === 410);

  const s2 = await setup();
  const g2 = await takeControl(s2.control(), s2.agencyId, s2.ownerId);
  const result = await release(s2.control(), s2.agencyId, s2.ownerId, "done", g2.leaseId);
  assert.equal(result.runId, null);
  const stop = runScripts(s2.world).at(-1)!;
  assert.equal(stop.user, "root");
  assert.match(stop.script, /rm -f \/run\/spherum\/tokens\/control/);
  assert.match(stop.script, /spherum-control-vnc stop/);
  assert.match(stop.script, /spherum-pty stop/);
  const row = (await loadComputer(sql, s2.agencyId))!;
  assert.equal(row.control_user_id, null);
  assert.equal(row.control_token_hash, null);
  assert.equal(row.control_lease_id, null);
  await assert.rejects(release(s2.control(), s2.agencyId, s2.ownerId, "done"), /Ninguém está no controle/);
});

test("ferramentas do computador recusadas enquanto alguém está no controle", async () => {
  const s = await setup();
  await ensureRunning(s.computer, s.agencyId);
  await takeControl(s.control(), s.agencyId, s.ownerId);
  const model = new FakeModel([
    { toolCalls: [{ id: "c1", name: "pedir_controle", input: { motivo: "Login" } }] },
    { text: "Vou esperar." },
  ]);
  const engine = s.engineFor(model);
  const runId = await startRun(engine, { xodoId: s.xodo.id, agencyId: s.agencyId, trigger: "user", text: "Oi", userId: s.ownerId });
  assert.equal(await continueRun(engine, runId), "completed");
  const [result] = model.lastToolResults();
  assert.equal(result.isError, true);
  assert.match(result.content, /Uma pessoa da equipe está usando o computador/);
  const denied = await one(sql, `select 1 from computer_events where agency_id = $1 and kind = 'pedir_controle' and status = 'denied'`, [s.agencyId]);
  assert.ok(denied);
});

test("devolver com 'done' e 'skipped' retoma a execução que esperava, com a nota certa", async () => {
  for (const reason of ["done", "skipped"] as const) {
    const s = await setup();
    const model = new FakeModel([
      { toolCalls: [{ id: "c1", name: "pedir_controle", input: { motivo: "Faça o login no Meta Business" } }] },
      { text: "Continuei." },
    ]);
    const runId = await waitingRun(s, model);
    const grant = await takeControl(s.control(model), s.agencyId, s.ownerId);
    assert.equal(grant.runId, runId, "o lease aponta a execução que espera");
    const result = await release(s.control(model), s.agencyId, s.ownerId, reason);
    assert.equal(result.runId, runId);
    assert.equal(result.resumed, "completed");
    assert.equal(await runStatus(runId), "completed");
    const note = String(model.requests.at(-1)!.messages.at(-1)!.content);
    assert.match(note, reason === "done" ? /A pessoa terminou o que você pediu/ : /A pessoa não fez o que você pediu/);
  }
});

test("vencimento pelo cron derruba o controle e retoma com 'expired'", async () => {
  // O cron olha todas as agências: tira os leases deixados pelos outros testes.
  await sql.query(`update computers set control_user_id = null, control_lease_id = null, control_expires_at = null, control_token_hash = null`);
  const s = await setup();
  const model = new FakeModel([
    { toolCalls: [{ id: "c1", name: "pedir_controle", input: { motivo: "Resolva o captcha" } }] },
    { text: "Segui sem o captcha." },
  ]);
  const runId = await waitingRun(s, model);
  await takeControl(s.control(model), s.agencyId, s.ownerId);
  assert.equal(await expireControls(s.control(model)), 0, "ainda não venceu");
  s.clock.advance(CONTROL_LEASE_MS - 60_000);
  // A máquina segue ligada pela atividade (heartbeat estende), mas aqui ninguém renovou o controle.
  await ensureRunning(s.computer, s.agencyId);
  s.clock.advance(2 * 60_000);
  assert.equal(await expireControls(s.control(model)), 1);
  const row = (await loadComputer(sql, s.agencyId))!;
  assert.equal(row.control_user_id, null);
  assert.match(runScripts(s.world).at(-1)!.script, /spherum-control-vnc stop/);
  assert.equal(await runStatus(runId), "completed");
  assert.match(String(model.requests.at(-1)!.messages.at(-1)!.content), /Ninguém assumiu o computador a tempo/);
  const ev = await one(sql, `select 1 from computer_events where agency_id = $1 and kind = 'controle_vencido'`, [s.agencyId]);
  assert.ok(ev);
});

test("link de devolução: uso único, preso ao lease, retoma com 'done'", async () => {
  const s = await setup();
  const model = new FakeModel([
    { toolCalls: [{ id: "c1", name: "pedir_controle", input: { motivo: "Assine o contrato" } }] },
    { text: "Obrigado." },
  ]);
  const runId = await waitingRun(s, model);
  const grant = await takeControl(s.control(model), s.agencyId, s.ownerId);
  const [lease, mac] = grant.releaseToken.split(".");
  await assert.rejects(releaseByLink(s.control(model), `${lease}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`), /Link inválido/);
  await assert.rejects(releaseByLink(s.control(model), `${randomUUID()}.${mac}`), /Link inválido/);
  await assert.rejects(releaseByLink(s.control(model), "lixo"), /Link inválido/);
  const result = await releaseByLink(s.control(model), grant.releaseToken);
  assert.equal(result.resumed, "completed");
  assert.equal(await runStatus(runId), "completed");
  await assert.rejects(releaseByLink(s.control(model), grant.releaseToken), /Link inválido ou já usado/);

  // O link de um lease antigo não devolve o lease novo.
  const again = await takeControl(s.control(model), s.agencyId, s.ownerId);
  await assert.rejects(releaseByLink(s.control(model), grant.releaseToken), /Link inválido/);
  assert.equal((await loadComputer(sql, s.agencyId))!.control_lease_id, again.leaseId);
});

test("mensagem da pessoa no chat vale como 'done'", async () => {
  const s = await setup();
  const model = new FakeModel([
    { toolCalls: [{ id: "c1", name: "pedir_controle", input: { motivo: "Login" } }] },
    { text: "Seguindo." },
    { toolCalls: [{ id: "c2", name: "pedir_controle", input: { motivo: "Login de novo" } }] },
    { text: "Seguindo de novo." },
  ]);
  // Sem ninguém no controle: só retoma.
  const runId = await waitingRun(s, model);
  assert.equal(await takeoverDoneByMessage(s.control(model), runId, s.ownerId), true);
  assert.equal(await runStatus(runId), "completed");
  assert.equal(await takeoverDoneByMessage(s.control(model), runId, s.ownerId), false, "execução que não espera não é tocada");

  // Com a própria pessoa no controle: devolve e retoma.
  const second = await waitingRun(s, model);
  const other = await member(s.agencyId, "member");
  await takeControl(s.control(model), s.agencyId, other);
  assert.equal(await takeoverDoneByMessage(s.control(model), second, s.ownerId), false, "outra pessoa ainda está lá");
  assert.equal(await runStatus(second), "waiting_takeover");
  assert.equal(await takeoverDoneByMessage(s.control(model), second, other), true);
  assert.equal(await runStatus(second), "completed");
  assert.equal((await loadComputer(sql, s.agencyId))!.control_user_id, null);
});

test("tela ao vivo: token de assistir de 15 min; controle e terminal só para quem segura", async () => {
  const s = await setup();
  const viewer = await member(s.agencyId, "viewer");
  const paused = await screenUrls(s.control(), s.agencyId, viewer, "viewer");
  assert.equal(paused.live, false);
  assert.equal(paused.viewUrl, null);
  assert.ok(!s.world.calls.some((c) => c.op === "create"), "abrir a tela não liga a máquina");

  await ensureRunning(s.computer, s.agencyId);
  const watch = await screenUrls(s.control(), s.agencyId, viewer, "viewer");
  assert.equal(watch.live, true);
  assert.match(watch.viewUrl!, /\/view\.html#t=v-[A-Za-z0-9_-]{43}$/);
  assert.equal(watch.control, null);
  const viewToken = tokenOf(watch.viewUrl!).slice(2);
  const script = runScripts(s.world).at(-1)!.script;
  assert.ok(!script.includes(viewToken));
  assert.match(script, /\/run\/spherum\/tokens\/view-[a-f0-9]{16}/);
  assert.match(script, /vnc-view\.sock/);

  const grant = await takeControl(s.control(), s.agencyId, s.ownerId);
  const mine = await screenUrls(s.control(), s.agencyId, s.ownerId, "owner");
  assert.ok(mine.control);
  assert.equal(mine.control.leaseId, grant.leaseId);
  const rotated = tokenOf(mine.control.viewUrl).slice(2);
  assert.notEqual(rotated, tokenOf(grant.viewUrl).slice(2), "token novo a cada pedido");
  assert.equal((await loadComputer(sql, s.agencyId))!.control_token_hash, hashToken(rotated));
  assert.equal((await screenUrls(s.control(), s.agencyId, viewer, "viewer")).control, null);
});

test("estado do card sem campos secretos; pausar recusado com alguém no controle", async () => {
  const s = await setup();
  await ensureRunning(s.computer, s.agencyId);
  const grant = await takeControl(s.control(), s.agencyId, s.ownerId);
  for (let i = 0; i < 4; i += 1) {
    s.clock.advance(9 * 60_000);
    await heartbeat(s.control(), s.agencyId, s.ownerId, grant.leaseId);
  }
  const state = await getComputerState(s.computer, s.agencyId, s.ownerId);
  const text = JSON.stringify(state);
  const row = (await loadComputer(sql, s.agencyId))!;
  for (const secret of [row.provider_ref!, row.control_token_hash!, PROVIDER_KEY]) assert.ok(!text.includes(secret));
  assert.ok(!/provider_ref|token_hash|ciphertext/.test(text));
  assert.equal(state.computer!.state, "running");
  assert.equal(state.computer!.live, true);
  assert.equal(state.control!.user_id, s.ownerId);
  assert.equal(state.control!.mine, true);
  assert.equal(state.control!.lease_id, grant.leaseId);
  assert.ok(state.usage_today!.hours >= 0.5);
  assert.equal(state.usage_today!.cap_hours, 4);
  assert.equal(state.last_activity.kind, "assumir_controle");

  const other = await member(s.agencyId, "member");
  const seen = await getComputerState(s.computer, s.agencyId, other);
  assert.equal(seen.control!.mine, false);
  assert.equal(seen.control!.lease_id, null, "o lease só aparece para quem segura");

  await assert.rejects(stopComputer(s.computer, s.agencyId, other), /usando o computador/);
  await assert.rejects(stopComputer(s.computer, s.agencyId, s.ownerId), /Devolva o controle/);
});

test("chave de máquina cifrada no cofre; listagem sem a chave; regras de site validadas; eventos paginados", async () => {
  const { agencyId, ownerId } = await seedAgency(sql);
  const key = await createSandboxKey(sql, agencyId, { provider: "daytona", label: "Daytona", api_key: "dtn_minha_chave_9876" }, ownerId, MASTER);
  assert.equal(key.key_last4, "9876");
  const stored = await one<{ ciphertext: string; kind: string }>(sql, `select ciphertext, kind from ai_credentials where id = $1`, [key.id]);
  assert.equal(stored!.kind, "sandbox");
  assert.ok(!stored!.ciphertext.includes("dtn_minha_chave"));
  assert.equal(await openSecret(stored!.ciphertext, credentialAad(agencyId, key.id), MASTER), "dtn_minha_chave_9876");
  const keys = await listSandboxKeys(sql, agencyId);
  assert.equal(keys.length, 1);
  assert.ok(!JSON.stringify(keys).includes("dtn_minha_chave"));
  await assert.rejects(createSandboxKey(sql, agencyId, { provider: "aws", label: "x", api_key: "12345678" }, ownerId, MASTER));
  await assert.rejects(createSandboxKey(sql, agencyId, { provider: "e2b", label: "x", api_key: "curta" }, ownerId, MASTER));

  const rules = await setSiteRules(sql, agencyId, ownerId, {
    rules: [
      { pattern: "https://Business.Facebook.com/", category: "campanha" },
      { pattern: "*.meubanco.com.br", category: "pagamento" },
      { pattern: "ads.google.com/aw", category: "campanha" },
    ],
  });
  assert.deepEqual(rules.map((r) => r.pattern), ["*.meubanco.com.br", "ads.google.com/aw", "business.facebook.com"]);
  for (const bad of ["*", "foo", "a.*.com", "user:pw@site.com", "site.com:8080", "site.com/?q=1", "site com.br"]) {
    await assert.rejects(setSiteRules(sql, agencyId, ownerId, { rules: [{ pattern: bad, category: "leitura" }] }), /inválid/, bad);
  }
  await assert.rejects(setSiteRules(sql, agencyId, ownerId, { rules: [{ pattern: "site.com", category: "qualquer" }] }));

  for (let i = 0; i < 5; i += 1) {
    await sql.query(`insert into computer_events (agency_id, kind, summary) values ($1, 'teste', $2)`, [agencyId, `evento ${i}`]);
  }
  const page1 = await listEvents(sql, agencyId, { limit: "3" });
  assert.equal(page1.events.length, 3);
  assert.equal(page1.events[0].summary, "evento 4");
  const page2 = await listEvents(sql, agencyId, { limit: "3", before: String(page1.next) });
  assert.deepEqual(page2.events.map((e) => e.summary), ["evento 1", "evento 0", "3 regra(s)"]);
  assert.equal(page2.next, null);
});
