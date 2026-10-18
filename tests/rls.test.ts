import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../src/lib/xodos/db";
import { createTestDb, seedAgency, seedClient, seedXodo } from "./helpers";

/** Leitura direta pelo navegador (supabase-js) passa por estas políticas. */

let db: PGlite;
let sql: Sql;
before(async () => {
  ({ db, sql } = await createTestDb());
});

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await db.query(`set role authenticated`);
  try {
    return await fn();
  } finally {
    await db.query(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

test("cada pessoa lê só a própria agência, e só lê", async () => {
  const a = await seedAgency(sql, "A");
  const b = await seedAgency(sql, "B");
  const xa = await seedXodo(sql, a.agencyId, { name: "Pipoca" });
  await seedXodo(sql, b.agencyId, { name: "Tico" });
  const clientA = await seedClient(sql, a.agencyId, "Loja Verano");
  await sql.query(`insert into reports (agency_id, client_id, period_start, period_end, title) values ($1, $2, '2026-10-01', '2026-10-31', 'Out')`, [a.agencyId, clientA]);
  await sql.query(`insert into notifications (agency_id, kind, title) values ($1, 'x', 'para todos'), ($2, 'x', 'da B')`, [a.agencyId, b.agencyId]);

  await asUser(a.ownerId, async () => {
    const xodos = await db.query<{ name: string }>(`select name from xodos`);
    assert.deepEqual(xodos.rows.map((r) => r.name), ["Pipoca"]);
    assert.equal((await db.query(`select * from reports`)).rows.length, 1);
    assert.deepEqual((await db.query<{ title: string }>(`select title from notifications`)).rows.map((r) => r.title), ["para todos"]);
    await assert.rejects(db.query(`update xodos set daily_budget_brl = 999 where id = $1`, [xa.id]), /permission denied/);
    await assert.rejects(db.query(`insert into approval_rules (agency_id, effect, match_kind, match_value) values ($1, 'always_allow', 'category', 'cliente')`, [a.agencyId]), /permission denied/);
    await assert.rejects(db.query(`delete from xodo_actions`), /permission denied/);
  });
});

test("a chave cifrada e a conversa interna nunca chegam ao navegador", async () => {
  const a = await seedAgency(sql, "C");
  await seedXodo(sql, a.agencyId);
  await asUser(a.ownerId, async () => {
    const safe = await db.query<{ label: string; key_last4: string }>(`select label, key_last4 from ai_credentials`);
    assert.deepEqual(safe.rows, [{ label: "Teste", key_last4: "abcd" }]);
    await assert.rejects(db.query(`select ciphertext from ai_credentials`), /permission denied/);
    await assert.rejects(db.query(`select * from ai_credentials`), /permission denied/);
    await assert.rejects(db.query(`select transcript from xodo_runs`), /permission denied/);
    await db.query(`select id, status, final_text from xodo_runs`);
  });
});

test("quem não está logado não lê nada", async () => {
  const a = await seedAgency(sql, "D");
  await seedXodo(sql, a.agencyId);
  await db.query(`set role anon`);
  try {
    await assert.rejects(db.query(`select * from xodos`), /permission denied/);
    await assert.rejects(db.query(`select * from fx_rates`), /permission denied/);
  } finally {
    await db.query(`reset role`);
  }
});
