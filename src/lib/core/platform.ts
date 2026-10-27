import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/**
 * Chaves da plataforma, decididas pela equipe do Spherum no admin: recursos ligados ou desligados
 * para todas as agências e os preços de tabela dos planos. Ficam em `site_settings`.
 */

export const FLAG_KEYS = ["xodo", "studio", "prospect", "signup", "maint"] as const;
export type Flag = (typeof FLAG_KEYS)[number];
export type Flags = Record<Flag, boolean>;
export const DEFAULT_FLAGS: Flags = { xodo: true, studio: true, prospect: true, signup: true, maint: false };

export const PLAN_IDS = ["solo", "agencia", "escala", "rede", "empresarial"] as const;
export type Prices = Record<(typeof PLAN_IDS)[number], number>;
export const DEFAULT_PRICES: Prices = { solo: 190, agencia: 490, escala: 990, rede: 1990, empresarial: 2900 };

// Lidas a cada pedido em várias rotas: 30 s de cache por processo bastam (uma mudança no admin vale em meio minuto).
let cache: { at: number; flags: Flags; prices: Prices } | null = null;

async function load(sql: Sql) {
  if (cache && Date.now() - cache.at < 30_000) return cache;
  const rows = await sql.query<{ key: string; value: unknown }>(`select key, value from site_settings where key in ('flags', 'prices')`);
  const get = (k: string) => (rows.find((r) => r.key === k)?.value ?? {}) as Record<string, unknown>;
  const f = get("flags"), p = get("prices");
  cache = {
    at: Date.now(),
    flags: Object.fromEntries(FLAG_KEYS.map((k) => [k, typeof f[k] === "boolean" ? f[k] : DEFAULT_FLAGS[k]])) as Flags,
    prices: Object.fromEntries(PLAN_IDS.map((k) => [k, typeof p[k] === "number" ? p[k] : DEFAULT_PRICES[k]])) as Prices,
  };
  return cache;
}

export const platformFlags = async (sql: Sql) => (await load(sql)).flags;
export const planPrices = async (sql: Sql) => (await load(sql)).prices;
export const resetPlatformCache = () => { cache = null; };

const OFF: Record<Exclude<Flag, "maint">, string> = {
  xodo: "Os xodós estão desligados por um momento pela equipe do Spherum. Tente de novo mais tarde.",
  studio: "O Estúdio está desligado por um momento pela equipe do Spherum. Tente de novo mais tarde.",
  prospect: "A Prospecção está desligada por um momento pela equipe do Spherum.",
  signup: "Novos cadastros estão pausados no momento. Fale com a gente pelo site.",
};

/** Recusa a ação quando a equipe do Spherum desligou o recurso para a plataforma. */
export async function requireFeature(sql: Sql, key: Exclude<Flag, "maint">) {
  if (!(await platformFlags(sql))[key]) throw new XodoError(OFF[key], 503);
}

export const flagsPatch = z.partialRecord(z.enum(FLAG_KEYS), z.boolean());
export const pricesInput = z.object(Object.fromEntries(PLAN_IDS.map((k) => [k, z.number().int().min(1).max(100_000)])) as Record<(typeof PLAN_IDS)[number], z.ZodNumber>);

export async function setFlags(sql: Sql, userId: string, raw: unknown) {
  const patch = flagsPatch.parse(raw);
  // Grava só as chaves alteradas, mesclando no banco: o cache de 30 s de cada servidor não pode
  // devolver um valor antigo (por exemplo, religar os xodós ao mexer em outra chave).
  const row = await one<{ value: Partial<Flags> }>(sql, `insert into site_settings (key, value, updated_by) values ('flags', $1::jsonb, $2)
    on conflict (key) do update set value = site_settings.value || excluded.value, updated_by = excluded.updated_by, updated_at = now() returning value`, [JSON.stringify(patch), userId]);
  resetPlatformCache();
  return { ...DEFAULT_FLAGS, ...(row?.value ?? {}) };
}

export async function setPrices(sql: Sql, userId: string, raw: unknown) {
  const p = pricesInput.parse(raw);
  // Cada plano custa mais que o anterior.
  PLAN_IDS.slice(1).forEach((k, i) => { if (p[k] <= p[PLAN_IDS[i]]) throw new XodoError(`O plano ${k} precisa custar mais que o ${PLAN_IDS[i]}.`, 400); });
  await sql.query(`insert into site_settings (key, value, updated_by) values ('prices', $1::jsonb, $2)
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [JSON.stringify(p), userId]);
  resetPlatformCache();
  return p;
}

/** Agência suspensa pela equipe do Spherum: a equipe e os clientes dela não entram. */
export async function assertAgencyActive(sql: Sql, agencyId: string) {
  const a = await one<{ suspended_at: string | null }>(sql, `select suspended_at::text from agencies where id = $1`, [agencyId]);
  if (a?.suspended_at) throw new XodoError("Esta agência está suspensa. Fale com o suporte do Spherum (suporte@spherum.com.br).", 403);
}

/** Por que um xodó não pode agir agora nesta agência (suspensa ou xodós desligados), ou null. */
export async function xodoBlocked(sql: Sql, agencyId: string): Promise<string | null> {
  const [a, flags] = await Promise.all([one<{ suspended: boolean }>(sql, `select suspended_at is not null as suspended from agencies where id = $1`, [agencyId]), platformFlags(sql)]);
  if (a?.suspended) return "Esta agência está suspensa. Fale com o suporte do Spherum (suporte@spherum.com.br).";
  if (!flags.xodo) return OFF.xodo;
  return null;
}
