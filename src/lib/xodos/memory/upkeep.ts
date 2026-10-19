import type { Sql } from "../db";
import type { EngineDeps } from "../runner";
import type { Xodo } from "../types";

/**
 * Arrumação noturna da memória (contrato; a implementação completa substitui este arquivo).
 */

/** Cron: arruma a memória dos xodós que ainda não foram arrumados hoje (a partir das 3h locais). */
export async function tidyDueMemories(deps: EngineDeps, opts: { limit?: number; deadline?: number } = {}): Promise<unknown> {
  void deps;
  void opts;
  return { tidied: 0 };
}

/** Arruma a memória de um xodó agora (manual: no máximo uma vez por hora). */
export async function runTidy(deps: EngineDeps, xodo: Xodo, opts: { manual?: boolean } = {}): Promise<unknown> {
  void deps;
  void xodo;
  void opts;
  return {};
}

/** Retenção: notas apagadas há mais de 30 dias, diário antigo e capturas encerradas. */
export async function pruneMemoryHistory(sql: Sql, now: Date): Promise<unknown> {
  void sql;
  void now;
  return {};
}
