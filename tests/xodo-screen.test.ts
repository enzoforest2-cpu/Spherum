import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { one, type Sql } from "../src/lib/xodos/db";
import { describeAction, xodoScreen } from "../src/lib/xodos/screen";
import { createTestDb, seedAgency, seedXodo } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const NOW = new Date("2026-10-20T15:00:00Z");

test("frase do pedido: usa o resumo da ferramenta e o motivo do limite", () => {
  assert.equal(describeAction("publicar_relatorio", { relatorio_id: "x" }, "categoria publicar"), "Publicar um relatório no portal do cliente");
  assert.match(describeAction("publicar_relatorio", {}, "limite: acima de R$ 500"), /\(acima de R\$ 500\)$/);
  assert.equal(describeAction("ferramenta_sumida", {}, null), "Ferramenta sumida");
});

test("tela de xodós: estado de cada um, gasto do dia e do mês, pedidos, memória e rotinas", async () => {
  const { agencyId } = await seedAgency(sql, `Agência ${randomUUID()}`);
  const faisca = await seedXodo(sql, agencyId, { name: "Faísca", role: "Relatórios", daily_budget_brl: 20 });
  const zuca = await seedXodo(sql, agencyId, { name: "Zuca", species: "bibo", color: "Menta" });
  const nina = await seedXodo(sql, agencyId, { name: "Nina", species: "oki", color: "Ultramar", daily_budget_brl: 5 });
  const pausado = await seedXodo(sql, agencyId, { name: "Bento", status: "paused" });

  const run = (xodo: string, status: string, finished: string | null) =>
    one<{ id: string }>(sql, `insert into xodo_runs (xodo_id, agency_id, trigger, status, provider, model, started_at, finished_at) values ($1, $2, 'user', $3, 'faux', 'faux-1', $4::timestamptz - interval '5 minutes', $4::timestamptz) returning id`,
      [xodo, agencyId, status, finished ?? NOW.toISOString()]);
  const r1 = await run(faisca.id, "running", null);
  await sql.query(`update xodo_runs set finished_at = null where id = $1`, [r1!.id]);
  const r2 = await run(zuca.id, "waiting_approval", NOW.toISOString());
  await sql.query(
    `insert into xodo_actions (run_id, xodo_id, agency_id, tool_name, category, tool_call_id, step, call_index, input, input_hash, status, reason)
     values ($1, $2, $3, 'publicar_relatorio', 'publicar', 'c1', 1, 0, '{}'::jsonb, 'h', 'pending', 'categoria publicar')`,
    [r2!.id, zuca.id, agencyId],
  );
  await sql.query(`insert into xodo_budget_days (xodo_id, day, agency_id, spent_brl) values ($1, '2026-10-20', $2, 6.4), ($3, '2026-10-20', $2, 5)`, [faisca.id, agencyId, nina.id]);
  await sql.query(
    `insert into ai_usage (agency_id, xodo_id, provider, model, cost_usd, cost_source, cost_brl, call_id, day) values
       ($1, $2, 'faux', 'faux-1', 1, 'catalog', 5.5, $3, '2026-10-20'), ($1, $2, 'faux', 'faux-1', 1, 'catalog', 4.5, $4, '2026-10-02'), ($1, $2, 'faux', 'faux-1', 9, 'catalog', 49, $5, '2026-09-30')`,
    [agencyId, faisca.id, randomUUID(), randomUUID(), randomUUID()],
  );
  await sql.query(
    `insert into xodo_memory_items (xodo_id, agency_id, n, content, identity, source, pinned) values ($1, $2, 1, 'Mensais saem no 1º dia útil', 'a', 'equipe', true), ($1, $2, 2, 'Resumo de 1 página', 'b', 'xodo', false)`,
    [faisca.id, agencyId],
  );
  await sql.query(`insert into xodo_routines (xodo_id, agency_id, name, prompt, cron) values ($1, $2, 'Relatórios mensais', 'Monte os relatórios', '0 8 1 * *')`, [faisca.id, agencyId]);

  const s = await xodoScreen(sql, agencyId, NOW);
  const by = (n: string) => s.xodos.find((x) => x.name === n)!;
  assert.deepEqual(s.xodos.map((x) => x.name), ["Faísca", "Zuca", "Nina", "Bento"]);
  assert.deepEqual([by("Faísca").state, by("Zuca").state, by("Nina").state, by("Bento").state], ["working", "needsYou", "paused", "paused_manual"]);
  assert.deepEqual([by("Faísca").spent_today, by("Faísca").spent_month, by("Faísca").daily_budget_brl], [6.4, 10, 20]);
  assert.equal(s.month_brl, 10);
  assert.deepEqual(by("Faísca").memory, ["Mensais saem no 1º dia útil", "Resumo de 1 página"]);
  assert.equal(by("Faísca").routines[0].name, "Relatórios mensais");
  assert.equal(s.approvals.length, 1);
  assert.deepEqual([s.approvals[0].xodo_id, s.approvals[0].summary], [zuca.id, "Publicar um relatório no portal do cliente"]);
  assert.equal(s.credentials.length, 4);
  void pausado;

  const other = await seedAgency(sql, `Outra ${randomUUID()}`);
  assert.equal((await xodoScreen(sql, other.agencyId, NOW)).xodos.length, 0, "isolado por agência");
});

test("pausar e excluir xodó: exclusão pede o nome, não acontece no meio de tarefa e leva conversas e rotinas junto", async () => {
  const { deleteXodo } = await import("../src/lib/xodos/manage");
  const { agencyId } = await seedAgency(sql, `Agência ${randomUUID()}`);
  const x = await seedXodo(sql, agencyId, { name: "Bolota" });
  const run = await one<{ id: string }>(sql, `insert into xodo_runs (xodo_id, agency_id, trigger, status, provider, model) values ($1, $2, 'user', 'running', 'faux', 'faux-1') returning id`, [x.id, agencyId]);
  await sql.query(`insert into xodo_messages (xodo_id, agency_id, run_id, role, text) values ($1, $2, $3, 'user', 'oi')`, [x.id, agencyId, run!.id]);
  await sql.query(`insert into xodo_routines (xodo_id, agency_id, name, prompt, cron) values ($1, $2, 'R', 'p', '0 8 * * 1')`, [x.id, agencyId]);
  await sql.query(`insert into ai_usage (agency_id, xodo_id, provider, model, cost_source, call_id, day) values ($1, $2, 'faux', 'faux-1', 'catalog', $3, '2026-10-20')`, [agencyId, x.id, randomUUID()]);

  await assert.rejects(deleteXodo(sql, agencyId, x.id, "outro"), /Digite "Bolota"/);
  await assert.rejects(deleteXodo(sql, agencyId, x.id, "bolota"), /meio de uma tarefa/);
  await sql.query(`update xodo_runs set status = 'completed' where id = $1`, [run!.id]);
  const other = await seedAgency(sql, `Outra ${randomUUID()}`);
  await assert.rejects(deleteXodo(sql, other.agencyId, x.id, "Bolota"), /não encontrado/);
  assert.deepEqual(await deleteXodo(sql, agencyId, x.id, " Bolota "), { name: "Bolota" });
  for (const t of ["xodos where id", "xodo_messages where xodo_id", "xodo_routines where xodo_id", "xodo_runs where xodo_id"]) {
    assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from ${t} = $1`, [x.id]))!.n, 0, t);
  }
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from ai_usage where xodo_id = $1`, [x.id]))!.n, 1, "gasto fica");
});
