import assert from "node:assert/strict";
import { before, test } from "node:test";
import { isolated, json, one, POSTGRES_TYPES, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

// Roda também contra um Postgres de verdade com TEST_PG_URL (mesmo driver e opções da produção).
let sql: Sql;
before(async () => { ({ sql } = await createTestDb()); });

test("jsonb: o texto de json() é gravado como objeto, não como string JSON", async () => {
  assert.equal(POSTGRES_TYPES.json.serialize('{"a":1}'), '{"a":1}');
  assert.equal(POSTGRES_TYPES.json.serialize({ a: 1 }), '{"a":1}');
  const r = await one<{ t: string }>(sql, `select jsonb_typeof($1::jsonb) as t`, [json({ a: 1 })]);
  assert.equal(r!.t, "object");
});

test("isolated: erro dentro do trecho desfaz só o trecho e a transação segue", async () => {
  await sql.query(`create table if not exists t_iso (n int primary key)`);
  const out = await sql.transaction(async (tx) => {
    await tx.query(`insert into t_iso values (1)`);
    await isolated(tx, (sp) => sp.query(`insert into t_iso values (1)`)).catch(() => "duplicado");
    await isolated(tx, (sp) => sp.query(`insert into t_iso values (2)`));
    return (await tx.query<{ n: number }>(`select n from t_iso order by n`)).map((x) => Number(x.n));
  });
  assert.deepEqual(out, [1, 2]);
  assert.equal((await sql.query(`select 1 from t_iso`)).length, 2, "a transação foi confirmada");
});
