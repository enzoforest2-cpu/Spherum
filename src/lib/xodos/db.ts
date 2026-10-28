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

let shared: Sql | null = null;

/**
 * DATABASE_URL, ou a POSTGRES_URL que a integração Supabase da Vercel cria sozinha (pooler em
 * modo transação). Conserta os erros comuns de quem cola o endereço à mão: aspas ou
 * "DATABASE_URL=" junto, os colchetes de [YOUR-PASSWORD] mantidos e senha com @ # / ? sem
 * codificar. Tira os parâmetros só da Supabase (supa, pgbouncer) que o Postgres recusaria.
 */
export function databaseUrl(env: Record<string, string | undefined>): string | null {
  let raw = (env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim() || "").replace(/^DATABASE_URL\s*=\s*/i, "");
  raw = raw.replace(/^["']|["']$/g, "").trim();
  if (!raw) return null;
  const parts = raw.match(/^(postgres(?:ql)?:\/\/)([^:/@]+):(.*)@([^@/?#]+)(\/[^?#]*)?(\?.*)?$/i);
  if (parts) {
    const [, scheme, user, rawPass, host, path = "/postgres", query = ""] = parts;
    let pass = rawPass;
    if (pass.startsWith("[") && pass.endsWith("]")) pass = pass.slice(1, -1);
    try {
      pass = decodeURIComponent(pass);
    } catch {}
    raw = `${scheme}${user}:${encodeURIComponent(pass)}@${host}${path}${query}`;
  }
  try {
    const url = new URL(raw);
    url.searchParams.delete("supa");
    url.searchParams.delete("pgbouncer");
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * Conexão de serviço do servidor (DATABASE_URL do Supabase, de preferência o pooler
 * em modo transação, porta 6543). Ignora RLS; por isso todo SQL do motor filtra por agency_id.
 */
export async function serverSql(): Promise<Sql> {
  if (shared) return shared;
  const url = databaseUrl(process.env);
  if (!url) throw new Error("DATABASE_URL não configurada");
  const { default: postgres } = await import("postgres");
  shared = fromPostgres(postgres(url, { prepare: false, max: 5 }) as unknown as PostgresLike);
  return shared;
}
