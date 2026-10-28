import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseUrl } from "../src/lib/xodos/db";

test("usa DATABASE_URL e, sem ela, a POSTGRES_URL da integração sem os parâmetros só da Supabase", () => {
  assert.equal(databaseUrl({}), null);
  assert.equal(databaseUrl({ DATABASE_URL: "postgres://u:p@h:6543/postgres" }), "postgres://u:p@h:6543/postgres");
  assert.equal(
    databaseUrl({ POSTGRES_URL: "postgres://u:p@h:6543/postgres?sslmode=require&supa=base-pooler.x" }),
    "postgres://u:p@h:6543/postgres?sslmode=require",
  );
  assert.equal(databaseUrl({ DATABASE_URL: "postgres://a@h/db", POSTGRES_URL: "postgres://b@h/db" }), "postgres://a@h/db");
});
