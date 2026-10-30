import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseUrl, sslOption } from "../src/lib/xodos/db";

test("usa DATABASE_URL e, sem ela, a POSTGRES_URL da integração sem os parâmetros só da Supabase", () => {
  assert.equal(databaseUrl({}), null);
  assert.equal(databaseUrl({ DATABASE_URL: "postgres://u:p@h:6543/postgres" }), "postgres://u:p@h:6543/postgres");
  assert.equal(
    databaseUrl({ POSTGRES_URL: "postgres://u:p@h:6543/postgres?sslmode=require&supa=base-pooler.x" }),
    "postgres://u:p@h:6543/postgres?sslmode=require",
  );
  assert.equal(databaseUrl({ DATABASE_URL: "postgres://a@h/db", POSTGRES_URL: "postgres://b@h/db" }), "postgres://a@h/db");
});

test("conserta senha com símbolos, colchetes mantidos e aspas", () => {
  const ok = (v: string) => new URL(databaseUrl({ DATABASE_URL: v })!);
  const a = ok("postgresql://postgres.abc:minha@senha#1/x?@aws-0-sa-east-1.pooler.supabase.com:6543/postgres");
  assert.equal(decodeURIComponent(a.password), "minha@senha#1/x?");
  assert.equal(a.port, "6543");
  assert.equal(a.hostname, "aws-0-sa-east-1.pooler.supabase.com");
  assert.equal(decodeURIComponent(ok("postgresql://postgres.abc:[Segredo123]@h.pooler.supabase.com:6543/postgres").password), "Segredo123");
  assert.equal(decodeURIComponent(ok('"postgresql://postgres.abc:x%40y@h:6543/postgres"').password), "x@y");
  assert.equal(ok("DATABASE_URL=postgresql://u:p@h:6543/postgres").username, "u");
});

test("SSL obrigatório fora do banco local, a menos que o endereço diga o sslmode", () => {
  assert.equal(sslOption("postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"), "require");
  assert.equal(sslOption("postgres://postgres@127.0.0.1:5499/postgres"), false);
  assert.equal(sslOption("postgres://u:p@localhost/postgres"), false);
  assert.equal(sslOption("postgres://u:p@h:6543/postgres?sslmode=verify-full"), undefined);
});
