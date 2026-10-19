import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import {
  configureComputer,
  destroyComputer,
  ensureRunning,
  loadComputer,
  pauseComputer,
  sweepComputers,
  type ComputerDeps,
} from "../src/lib/computer/lifecycle";
import { fakeProvider, fakeWorld } from "../src/lib/computer/providers/fake";
import { one, type Sql } from "../src/lib/xodos/db";
import { credentialAad, sealSecret } from "../src/lib/xodos/vault";
import { Clock, createTestDb, seedAgency, seedFx } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
  await seedFx(sql, "2026-10-19", 5);
});

async function sandboxKey(agencyId: string, provider = "e2b", key = "e2b_chave_da_agencia") {
  const id = randomUUID();
  await sql.query(
    `insert into ai_credentials (id, agency_id, provider, label, ciphertext, key_last4, kind) values ($1, $2, $3, 'Máquina', $4, $5, 'sandbox')`,
    [id, agencyId, provider, await sealSecret(key, credentialAad(agencyId, id), MASTER), key.slice(-4)],
  );
  return id;
}

async function setup(opts: { cap?: number } = {}) {
  const { agencyId } = await seedAgency(sql);
  const world = fakeWorld();
  const keys: string[] = [];
  const clock = new Clock(new Date("2026-10-19T12:00:00Z"));
  const deps: ComputerDeps = {
    sql,
    now: clock.now,
    masterKey: MASTER,
    providers: {
      e2b: (key) => {
        keys.push(key);
        return fakeProvider(world)(key);
      },
    },
  };
  const credential = await sandboxKey(agencyId);
  await configureComputer(deps, agencyId, { provider: "e2b", credential_id: credential, daily_hours_cap: opts.cap });
  return { agencyId, world, deps, clock, keys, credential };
}

const ops = (world: ReturnType<typeof fakeWorld>) => world.calls.map((c) => c.op);

test("configurar: chave de máquina da própria agência e do provedor certo", async () => {
  const { agencyId } = await seedAgency(sql);
  const other = await seedAgency(sql);
  const deps: ComputerDeps = { sql, masterKey: MASTER, providers: {} };
  await assert.rejects(configureComputer(deps, agencyId, { provider: "e2b" }), /Cadastre a chave/);
  const foreign = await sandboxKey(other.agencyId);
  await assert.rejects(configureComputer(deps, agencyId, { provider: "e2b", credential_id: foreign }), /não encontrada/);
  const daytona = await sandboxKey(agencyId, "daytona");
  await assert.rejects(configureComputer(deps, agencyId, { provider: "e2b", credential_id: daytona }), /não encontrada/);
  // Chave de modelo não serve como chave de máquina.
  const model = await one<{ id: string }>(
    sql,
    `insert into ai_credentials (agency_id, provider, label, ciphertext, key_last4) values ($1, 'e2b', 'x', 'v1:x', 'abcd') returning id`,
    [agencyId],
  );
  await assert.rejects(configureComputer(deps, agencyId, { provider: "e2b", credential_id: model!.id }), /não encontrada/);
  const row = await configureComputer(deps, agencyId, { provider: "daytona", credential_id: daytona, idle_minutes: 5 });
  assert.deepEqual([row.provider, row.idle_ms, row.state], ["daytona", 300_000, "none"]);
});

test("ligar cria e prepara uma vez; depois só estende; passado o prazo, retoma; sumida, recria", async () => {
  const s = await setup();
  const first = await ensureRunning(s.deps, s.agencyId);
  assert.equal(first.computer.state, "running");
  assert.equal(first.computer.generation, 1);
  assert.deepEqual(s.keys, ["e2b_chave_da_agencia"], "usa a chave da agência, decifrada só no servidor");
  const again = await ensureRunning(s.deps, s.agencyId);
  assert.equal(again.ref, first.ref);
  assert.deepEqual(ops(s.world), ["create", "extend"]);

  // 11 minutos sem atividade: o provedor pausou sozinho; a próxima ferramenta retoma.
  s.clock.advance(11 * 60_000);
  s.world.machines.get(first.ref)!.state = "paused";
  const resumed = await ensureRunning(s.deps, s.agencyId);
  assert.equal(resumed.ref, first.ref);
  assert.equal(ops(s.world).at(-1), "resume");
  const sessions = await sql.query<{ seconds: number | null }>(
    `select seconds from computer_sessions where computer_id = $1 order by id`,
    [resumed.computer.id],
  );
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].seconds, 600, "a primeira sessão fecha no prazo de ociosidade, não na hora da retomada");

  // A máquina sumiu no provedor: recria (geração 2).
  s.world.vanish(first.ref);
  const recreated = await ensureRunning(s.deps, s.agencyId);
  assert.notEqual(recreated.ref, first.ref);
  assert.equal(recreated.computer.generation, 2);
});

test("duas chamadas ao mesmo tempo criam uma máquina só", async () => {
  const s = await setup();
  const results = await Promise.allSettled([ensureRunning(s.deps, s.agencyId), ensureRunning(s.deps, s.agencyId)]);
  assert.equal(s.world.calls.filter((c) => c.op === "create").length, 1);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /ligando/);
});

test("teto de horas do dia recusa ligar; pausar fecha a sessão com tempo e custo em reais", async () => {
  const s = await setup({ cap: 0.25 });
  const running = await ensureRunning(s.deps, s.agencyId);
  s.clock.advance(15 * 60_000);
  await pauseComputer(s.deps, s.agencyId);
  const session = await one<{ seconds: number; cost_usd: string; cost_brl: string }>(
    sql,
    `select seconds, cost_usd, cost_brl from computer_sessions where computer_id = $1`,
    [running.computer.id],
  );
  assert.equal(session!.seconds, 900);
  assert.equal(Number(session!.cost_usd), 0.0425);
  assert.equal(Number(session!.cost_brl), 0.2125);
  await assert.rejects(ensureRunning(s.deps, s.agencyId), /já usou as 0.25 horas/);
});

test("cron: dá como pausada a máquina vencida, pausa sessão longa e vence controle e tela", async () => {
  const s = await setup();
  const running = await ensureRunning(s.deps, s.agencyId);
  await sql.query(
    `update computers set control_user_id = $2, control_expires_at = $3::timestamptz, screen_run_id = $2, screen_expires_at = $3::timestamptz where id = $1`,
    [running.computer.id, randomUUID(), new Date(s.clock.now().getTime() + 60_000).toISOString()],
  );
  s.clock.advance(11 * 60_000);
  // A base é compartilhada entre os testes: confere a máquina desta agência.
  const result = await sweepComputers(s.deps);
  assert.ok(result.paused >= 1 && result.expiredControls >= 1);
  const row = await loadComputer(sql, s.agencyId);
  assert.deepEqual([row!.state, row!.control_user_id, row!.screen_run_id], ["paused", null, null]);

  // Sessão contínua de mais de 2 h sem ninguém no controle é pausada.
  await ensureRunning(s.deps, s.agencyId);
  for (let i = 0; i < 14; i += 1) {
    s.clock.advance(9 * 60_000);
    await ensureRunning(s.deps, s.agencyId);
  }
  assert.ok((await sweepComputers(s.deps)).longSessions >= 1);
  assert.equal((await loadComputer(sql, s.agencyId))!.state, "paused");
});

test("destruir apaga a máquina no provedor e limpa o controle; transição presa é retomada", async () => {
  const s = await setup();
  const running = await ensureRunning(s.deps, s.agencyId);
  await destroyComputer(s.deps, s.agencyId, null);
  assert.equal(s.world.machines.get(running.ref)!.state, "destroyed");
  assert.equal((await loadComputer(sql, s.agencyId))!.state, "destroyed");
  const events = await sql.query<{ kind: string }>(`select kind from computer_events where agency_id = $1 order by id`, [s.agencyId]);
  assert.deepEqual(events.map((e) => e.kind), ["criar", "destruir"]);

  // Uma chamada morreu no meio da criação: depois de 2 minutos, outra retoma e cria.
  await sql.query(`update computers set state = 'provisioning', transition_at = $2::timestamptz where agency_id = $1`, [
    s.agencyId,
    s.clock.now().toISOString(),
  ]);
  await assert.rejects(ensureRunning(s.deps, s.agencyId), /ligando/);
  s.clock.advance(3 * 60_000);
  assert.equal((await ensureRunning(s.deps, s.agencyId)).computer.state, "running");
});
