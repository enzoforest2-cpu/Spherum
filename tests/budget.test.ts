import assert from "node:assert/strict";
import { before, test } from "node:test";
import { dayIn, reserveBudget, settleBudget } from "../src/lib/xodos/budget";
import { num, type Sql } from "../src/lib/xodos/db";
import { createTestDb, seedAgency, seedXodo } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const notifications = (agencyId: string) =>
  sql.query<{ kind: string }>(`select kind from notifications where agency_id = $1 order by id`, [agencyId]);

test("o dia do teto segue o fuso do xodó", () => {
  const at = new Date("2026-10-19T02:30:00Z");
  assert.equal(dayIn("America/Sao_Paulo", at), "2026-10-18");
  assert.equal(dayIn("UTC", at), "2026-10-19");
});

test("reserva, acerta e avisa uma vez ao passar de 80%", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, { daily_budget_usd: 1 });
  const day = "2026-10-19";

  const r1 = await reserveBudget(sql, xodo, day, 0.5);
  assert.deepEqual(r1, { ok: true, spent: 0, reserved: 0.5, cap: 1 });
  const s1 = await settleBudget(sql, xodo, day, 0.5, 0.3);
  assert.deepEqual(s1, { spent: 0.3, cap: 1, warned: false });

  await reserveBudget(sql, xodo, day, 0.5);
  const s2 = await settleBudget(sql, xodo, day, 0.5, 0.5);
  assert.equal(s2.warned, true);
  await reserveBudget(sql, xodo, day, 0.1);
  const s3 = await settleBudget(sql, xodo, day, 0.1, 0.05);
  assert.equal(s3.warned, false, "o aviso sai uma vez só por dia");

  const [row] = await sql.query(`select spent_usd, reserved_usd from xodo_budget_days where xodo_id = $1`, [xodo.id]);
  assert.equal(num(row.spent_usd), 0.85);
  assert.equal(num(row.reserved_usd), 0);
  assert.deepEqual((await notifications(agencyId)).map((n) => n.kind), ["budget_warning"]);
});

test("recusa quando a reserva não cabe e avisa uma vez que pausou", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, { daily_budget_usd: 1 });
  const day = "2026-10-19";

  assert.equal((await reserveBudget(sql, xodo, day, 0.7)).ok, true);
  // Conta o que já está reservado por outra chamada em andamento.
  const denied = await reserveBudget(sql, xodo, day, 0.4);
  assert.deepEqual(denied, { ok: false, spent: 0, reserved: 0.7, cap: 1 });
  assert.equal((await reserveBudget(sql, xodo, day, 0.4)).ok, false);
  assert.deepEqual((await notifications(agencyId)).map((n) => n.kind), ["budget_capped"]);

  // Outro dia começa do zero.
  assert.equal((await reserveBudget(sql, xodo, "2026-10-20", 0.9)).ok, true);
});

test("reservas simultâneas não estouram o teto", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, { daily_budget_usd: 1 });
  const results = await Promise.all(Array.from({ length: 10 }, () => reserveBudget(sql, xodo, "2026-10-19", 0.3)));
  assert.equal(results.filter((r) => r.ok).length, 3);
});
