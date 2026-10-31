import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { fromPGlite, type Sql } from "../src/xodos/db";

/**
 * O banco do app: Postgres embutido (PGlite), gravado numa pasta dentro dos dados.
 * As migrações são as do Spherum (o motor espera aquele esquema); cada uma roda uma vez só,
 * na ordem, e fica anotada em app_migrations.
 */

function dbDir(): string {
  // No pacote, os .sql vão ao lado do app (db/); no desenvolvimento, na raiz do repositório.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "db"), path.join(here, "..", "db")]) {
    try {
      readdirSync(path.join(candidate, "migrations"));
      return candidate;
    } catch {}
  }
  throw new Error("Pasta db/ com as migrações não encontrada.");
}

export type Database = { pg: PGlite; sql: Sql };

export async function openDatabase(dir: string | null): Promise<Database> {
  const pg = dir ? new PGlite(dir) : new PGlite();
  await pg.waitReady;
  await migrate(pg);
  return { pg, sql: fromPGlite(pg) };
}

async function migrate(pg: PGlite) {
  const base = dbDir();
  await pg.exec(`create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await pg.query<{ name: string }>(`select name from app_migrations`)).rows.map((r) => r.name));
  const steps = [
    { name: "000_foundation.sql", file: path.join(base, "foundation.sql") },
    ...readdirSync(path.join(base, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ name: f, file: path.join(base, "migrations", f) })),
  ];
  for (const step of steps) {
    if (done.has(step.name)) continue;
    const text = readFileSync(step.file, "utf8");
    await pg.transaction(async (tx) => {
      await tx.exec(text);
      await tx.query(`insert into app_migrations (name) values ($1)`, [step.name]);
    });
  }
}
