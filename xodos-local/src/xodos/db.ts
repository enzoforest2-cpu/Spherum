/**
 * Acesso ao banco usado pelo motor dos Xodós.
 *
 * O motor fala SQL puro por esta interface pequena, para rodar igual no Postgres do
 * Supabase (driver `postgres`) e no PGlite dos testes. Valores jsonb vão como texto
 * com `::jsonb` no SQL; numeric e bigint voltam como texto, então use `num()`.
 */
export interface Sql {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Abre uma transação. Dentro de uma transação, apenas reaproveita a atual. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

export type Row = Record<string, unknown>;

export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Objeto jsonb lido do banco (os drivers já fazem o parse, mas aceitamos texto). */
export function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export async function one<T = Row>(sql: Sql, text: string, params?: unknown[]): Promise<T | null> {
  const rows = await sql.query<T>(text, params);
  return rows[0] ?? null;
}

type PostgresLike = {
  unsafe(text: string, params?: unknown[]): Promise<unknown>;
  begin<T>(fn: (tx: PostgresLike) => Promise<T>): Promise<T>;
};

export function fromPostgres(client: PostgresLike, inTransaction = false): Sql {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return [...((await client.unsafe(text, params as never[])) as T[])];
    },
    transaction(fn) {
      if (inTransaction) return fn(this);
      return client.begin((tx) => fn(fromPostgres(tx, true)));
    },
  };
}

type PGliteLike = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction?<T>(fn: (tx: PGliteLike) => Promise<T>): Promise<T>;
};

export function fromPGlite(db: PGliteLike, inTransaction = false): Sql {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await db.query<T>(text, params)).rows;
    },
    transaction(fn) {
      if (inTransaction || !db.transaction) return fn(this);
      return db.transaction((tx) => fn(fromPGlite(tx, true)));
    },
  };
}
