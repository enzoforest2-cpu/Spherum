import { json, num, parseJson, type Sql } from "./db";
import type { Xodo } from "./types";

/**
 * Teto diário por xodó (padrão do Rakazo: reserva antes, acerto depois).
 *
 * Antes de cada chamada de modelo reservamos o pior caso. Se não couber, o xodó para
 * no passo atual. Depois da chamada liberamos a reserva e somamos o custo real. O aviso
 * de 80% e o de teto atingido saem uma única vez por dia.
 */

export function dayIn(timezone: string, at: Date): string {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export type Reservation = { ok: boolean; spent: number; reserved: number; cap: number };

export async function reserveBudget(sql: Sql, xodo: Xodo, day: string, estimateUsd: number): Promise<Reservation> {
  const [row] = await sql.query<{ r: unknown }>(`select xodo_budget_reserve($1, $2::date, $3) as r`, [
    xodo.id,
    day,
    estimateUsd,
  ]);
  const r = parseJson<{ ok: boolean; spent: unknown; reserved: unknown; cap: unknown; first_cap: boolean }>(row.r);
  if (!r.ok && r.first_cap) {
    await notify(sql, xodo.agency_id, {
      kind: "budget_capped",
      title: `${xodo.name} pausou: teto do dia atingido`,
      body: `Gasto de hoje: US$ ${num(r.spent).toFixed(2)} de US$ ${num(r.cap).toFixed(2)}. Ele volta amanhã ou quando o teto for aumentado.`,
      data: { xodo_id: xodo.id, day },
    });
  }
  return { ok: r.ok, spent: num(r.spent), reserved: num(r.reserved), cap: num(r.cap) };
}

export async function settleBudget(sql: Sql, xodo: Xodo, day: string, reservedUsd: number, actualUsd: number) {
  const [row] = await sql.query<{ r: unknown }>(`select xodo_budget_settle($1, $2::date, $3, $4) as r`, [
    xodo.id,
    day,
    reservedUsd,
    actualUsd,
  ]);
  const r = parseJson<{ spent: unknown; cap: unknown; warn_now: boolean }>(row.r);
  if (r.warn_now) {
    await notify(sql, xodo.agency_id, {
      kind: "budget_warning",
      title: `${xodo.name} já usou ${xodo.warn_at_percent}% do teto de hoje`,
      body: `Gasto de hoje: US$ ${num(r.spent).toFixed(2)} de US$ ${num(r.cap).toFixed(2)}.`,
      data: { xodo_id: xodo.id, day },
    });
  }
  return { spent: num(r.spent), cap: num(r.cap), warned: r.warn_now };
}

export type NotificationInput = {
  kind: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  userId?: string | null;
};

export async function notify(sql: Sql, agencyId: string, n: NotificationInput) {
  await sql.query(
    `insert into notifications (agency_id, user_id, kind, title, body, data) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [agencyId, n.userId ?? null, n.kind, n.title.slice(0, 200), n.body ?? "", json(n.data ?? {})],
  );
}
