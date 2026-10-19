import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { z } from "zod";
import { computerTool, partBlocked } from "../src/lib/computer/gateway";
import { configureComputer, type ComputerDeps } from "../src/lib/computer/lifecycle";
import { fakeProvider, fakeWorld } from "../src/lib/computer/providers/fake";
import { one, type Sql } from "../src/lib/xodos/db";
import { ToolError, type ToolContext } from "../src/lib/xodos/tools";
import type { Xodo } from "../src/lib/xodos/types";
import { credentialAad, sealSecret } from "../src/lib/xodos/vault";
import { Clock, createTestDb, seedAgency, seedXodo } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const echo = computerTool({
  name: "eco",
  description: "teste",
  category: "leitura",
  part: "files",
  input: z.object({ texto: z.string() }),
  summarize: (i) => `eco ${i.texto}`,
  async run(c, i) {
    const r = await c.machine.provider.run(c.machine.ref, { script: `echo ${i.texto}`, user: "xodo", timeoutMs: 1000 });
    return { saida: r.stdout };
  },
});
const screenTool = computerTool({
  name: "tela_teste",
  description: "teste",
  category: "leitura",
  part: "browser",
  screen: true,
  input: z.object({}),
  summarize: () => "tela",
  run: async () => ({ ok: true }),
});

async function setup(xodoOverrides: Partial<Record<keyof Xodo, unknown>> = { computer_mode: "cloud", computer_files: true, computer_browser: true }) {
  const { agencyId } = await seedAgency(sql);
  const world = fakeWorld();
  world.onRun = (script) => ({ code: 0, stdout: `${script.replace("echo ", "")} token: abc123`, stderr: "" });
  const clock = new Clock(new Date("2026-10-19T12:00:00Z"));
  const computer: ComputerDeps = { sql, now: clock.now, masterKey: MASTER, providers: { e2b: fakeProvider(world) } };
  const id = randomUUID();
  await sql.query(`insert into ai_credentials (id, agency_id, provider, label, ciphertext, key_last4, kind) values ($1, $2, 'e2b', 'x', $3, 'abcd', 'sandbox')`, [
    id,
    agencyId,
    await sealSecret("k", credentialAad(agencyId, id), MASTER),
  ]);
  await configureComputer(computer, agencyId, { provider: "e2b", credential_id: id });
  const xodo = await seedXodo(sql, agencyId, xodoOverrides);
  const ctx = (runId = randomUUID()): ToolContext => ({ sql, xodo, runId, now: clock.now(), apps: null, computer });
  return { agencyId, world, clock, xodo, ctx, computer };
}

test("cada parte do computador precisa estar ligada; terminal só para quem atende todos os clientes", () => {
  const base = { computer_mode: "cloud", computer_browser: false, computer_files: true, computer_terminal: true, client_scope: "all" } as Xodo;
  assert.equal(partBlocked({ ...base, computer_mode: "off" }, "files"), "O computador na nuvem está desligado para este xodó.");
  assert.match(partBlocked(base, "browser")!, /navegador/);
  assert.equal(partBlocked(base, "files"), null);
  assert.equal(partBlocked(base, "terminal"), null);
  assert.match(partBlocked({ ...base, client_scope: "selected" }, "terminal")!, /todos os clientes/);
});

test("liga a máquina, registra o evento e limpa dados sensíveis do resultado", async () => {
  const s = await setup();
  const out = (await echo.execute(s.ctx(), { texto: "oi" })) as { saida: string };
  assert.equal(out.saida, "oi token: [removido]");
  const events = await sql.query<{ kind: string; status: string; summary: string }>(
    `select kind, status, summary from computer_events where agency_id = $1 order by id`,
    [s.agencyId],
  );
  assert.deepEqual(events.map((e) => [e.kind, e.status]), [["criar", "succeeded"], ["eco", "succeeded"]]);
  assert.equal(events[1].summary, "arquivos: eco oi");
});

test("pessoa no controle: tudo recusa, sem enfileirar; desligado para o xodó também recusa", async () => {
  const s = await setup();
  await sql.query(`update computers set control_user_id = $2, control_expires_at = $3::timestamptz where agency_id = $1`, [
    s.agencyId,
    randomUUID(),
    new Date(s.clock.now().getTime() + 60_000).toISOString(),
  ]);
  await assert.rejects(echo.execute(s.ctx(), { texto: "oi" }), (e: unknown) => e instanceof ToolError && /usando o computador/.test(e.message));
  assert.equal(s.world.calls.length, 0, "nem liga a máquina");
  const off = await setup({ computer_mode: "off" });
  await assert.rejects(echo.execute(off.ctx(), { texto: "oi" }), /desligado/);
});

test("tela: uma execução por vez; a outra recebe o nome de quem está com ela", async () => {
  const s = await setup();
  const runA = randomUUID();
  await sql.query(`insert into xodo_runs (id, xodo_id, agency_id, trigger, provider, model) values ($1, $2, $3, 'user', 'faux', 'faux-1')`, [
    runA,
    s.xodo.id,
    s.agencyId,
  ]);
  await screenTool.execute(s.ctx(runA), {});
  await assert.rejects(screenTool.execute(s.ctx(), {}), /A tela do computador está com Pipoca agora/);
  // A mesma execução renova; passado o lease, outra pega.
  await screenTool.execute(s.ctx(runA), {});
  s.clock.advance(3 * 60_000);
  await screenTool.execute(s.ctx(), {});
  const row = await one<{ screen_run_id: string }>(sql, `select screen_run_id from computers where agency_id = $1`, [s.agencyId]);
  assert.notEqual(row!.screen_run_id, runA);
});

test("ferramenta do computador tem piso: cliente, pagamento e exclusão sempre perguntam", () => {
  assert.deepEqual(echo.floor, ["cliente", "pagamento", "exclusao"]);
});
