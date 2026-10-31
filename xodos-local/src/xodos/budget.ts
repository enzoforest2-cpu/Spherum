import { json, num, parseJson, type Sql } from "./db";
import type { Xodo } from "./types";

/**
 * Gasto do dia por xodó, em reais (padrão do Rakazo: reserva antes, acerto depois).
 *
 * Todo gasto é somado ao dia. O teto é opcional: sem teto, nada é reservado nem bloqueado.
 * Com teto, reservamos o pior caso antes de cada chamada; se não couber, o xodó para no
 * passo atual. O aviso no percentual escolhido e o de teto atingido saem uma vez por dia.
 */

export function dayIn(timezone: string, at: Date): string {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export type Reservation = { ok: boolean; spent: number; reserved: number; cap: number | null };

const brl = (value: unknown) => num(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export async function reserveBudget(sql: Sql, xodo: Xodo, day: string, estimateBrl: number): Promise<Reservation> {
  const [row] = await sql.query<{ r: unknown }>(`select xodo_budget_reserve($1, $2::date, $3) as r`, [
    xodo.id,
    day,
    estimateBrl,
  ]);
  const r = parseJson<{ ok: boolean; spent: unknown; reserved: unknown; cap: unknown; first_cap: boolean }>(row.r);
  if (!r.ok && r.first_cap) {
    await notify(sql, xodo.agency_id, {
      kind: "budget_capped",
      title: `${xodo.name} pausou: teto do dia atingido`,
      body: `Gasto de hoje: ${brl(r.spent)} de ${brl(r.cap)}. Ele volta amanhã ou quando o teto for aumentado.`,
      data: { xodo_id: xodo.id, day },
    });
  }
  return { ok: r.ok, spent: num(r.spent), reserved: num(r.reserved), cap: r.cap === null || r.cap === undefined ? null : num(r.cap) };
}

export async function settleBudget(sql: Sql, xodo: Xodo, day: string, reservedBrl: number, actualBrl: number) {
  const [row] = await sql.query<{ r: unknown }>(`select xodo_budget_settle($1, $2::date, $3, $4) as r`, [
    xodo.id,
    day,
    reservedBrl,
    actualBrl,
  ]);
  const r = parseJson<{ spent: unknown; cap: unknown; warn_now: boolean }>(row.r);
  if (r.warn_now) {
    await notify(sql, xodo.agency_id, {
      kind: "budget_warning",
      title: `${xodo.name} já usou ${xodo.warn_at_percent}% do teto de hoje`,
      body: `Gasto de hoje: ${brl(r.spent)} de ${brl(r.cap)}.`,
      data: { xodo_id: xodo.id, day },
    });
  }
  return { spent: num(r.spent), cap: r.cap === null || r.cap === undefined ? null : num(r.cap), warned: r.warn_now };
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
