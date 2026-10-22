import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { deleteTime, logTime, profitBoard, setCostPerHour } from "../src/lib/core/profit";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("rentabilidade: horas por cliente a custo/hora, rateio do custo dos xodós e horas economizadas", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Lucro" });
  const a = await createClient(sql, agencyId, dona, { name: "Academia", monthly_fee: 3000 });
  const b = await createClient(sql, agencyId, dona, { name: "Loja", monthly_fee: 1000 });
  await setCostPerHour(sql, agencyId, 100);
  const now = new Date("2026-10-21T15:00:00Z");
  await logTime(sql, agencyId, dona, { client_id: a.id, category: "trafego", minutes: 600, day: "2026-10-10" });
  await logTime(sql, agencyId, dona, { client_id: b.id, category: "reunioes", minutes: 900, day: "2026-10-12" });
  const old = await logTime(sql, agencyId, dona, { client_id: b.id, category: "outros", minutes: 600, day: "2026-08-01" });
  const xodo = (await one<{ id: string }>(sql, `select id from xodos limit 1`))?.id;
  void xodo;
  await sql.query(`insert into ai_usage (agency_id, provider, model, cost_source, cost_brl, call_id, day) values ($1, 'x', 'y', 'catalog', 60, $2, '2026-10-15')`, [agencyId, randomUUID()]);
  const board = await profitBoard(sql, agencyId, now);
  const A = board.rows.find((r) => r.name === "Academia")!, L = board.rows.find((r) => r.name === "Loja")!;
  assert.deepEqual([A.hours, A.cost, A.margin, A.split.find((s) => s.category === "trafego")!.hours], [10, 1000, 2000, 10]);
  assert.deepEqual([L.hours, L.cost, L.margin, L.margin_pct], [15, 1500, -500, -50], "registro de agosto fica fora dos 30 dias");
  assert.equal(A.xodo_cost + L.xodo_cost, 0, "sem ações executadas, nada é rateado");
  await deleteTime(sql, agencyId, randomUUID(), old.id, false).catch(() => {});
  await assert.rejects(deleteTime(sql, agencyId, randomUUID(), old.id, false), /não encontrado/, "só o dono do registro apaga");
  await deleteTime(sql, agencyId, dona, old.id, false);
  assert.equal((await profitBoard(sql, agencyId, now)).entries.length, 2);
});
