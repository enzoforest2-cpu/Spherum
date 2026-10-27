import { Cron } from "croner";
import { notify } from "./budget";
import { one, type Sql } from "./db";
import { continueRun, startRun, XodoError, type EngineDeps } from "./runner";

/**
 * Rotinas agendadas dos xodós (ex.: "relatório semanal toda segunda às 8h").
 *
 * O cron do servidor chama runDueRoutines(): cada rotina vencida é travada por 15 minutos
 * (sem sobreposição, mesmo com dois crons ao mesmo tempo), roda como uma execução normal
 * e agenda a próxima. Com "continuidade", o resumo da última execução entra na próxima.
 */

export const MIN_INTERVAL_MS = 60 * 60 * 1000;
const SUMMARY_MAX_CHARS = 2_000;

export function nextRunAt(cron: string, timezone: string, from: Date): Date | null {
  return new Cron(cron, { timezone, paused: true }).nextRun(from);
}

/** Valida a expressão e o fuso, e recusa rotinas que rodariam mais de uma vez por hora. */
export function validateCron(cron: string, timezone: string, from = new Date()): void {
  let runs: Date[];
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    runs = new Cron(cron, { timezone, paused: true }).nextRuns(4, from);
  } catch {
    throw new XodoError("Agenda inválida. Use o formato cron de 5 campos, por exemplo 0 8 * * 1.");
  }
  if (!runs.length) throw new XodoError("Essa agenda nunca roda.");
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MS) {
      throw new XodoError("Rotinas podem rodar no máximo uma vez por hora.");
    }
  }
}

export type RoutineInput = {
  agencyId: string;
  xodoId: string;
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  continuity?: boolean;
  createdBy?: string | null;
};

export async function createRoutine(sql: Sql, input: RoutineInput, now = new Date()) {
  const timezone = input.timezone ?? "America/Sao_Paulo";
  validateCron(input.cron, timezone, now);
  const row = await one<{ id: string; next_run_at: string }>(
    sql,
    `insert into xodo_routines (xodo_id, agency_id, name, prompt, cron, timezone, continuity, next_run_at, created_by)
     select x.id, x.agency_id, $3, $4, $5, $6, $7, $8::timestamptz, $9 from xodos x where x.id = $1 and x.agency_id = $2
     returning id, next_run_at::text`,
    [input.xodoId, input.agencyId, input.name, input.prompt, input.cron, timezone, input.continuity ?? true,
      nextRunAt(input.cron, timezone, now)?.toISOString() ?? null, input.createdBy ?? null],
  );
  if (!row) throw new XodoError("Xodó não encontrado", 404);
  return row;
}

type RoutineRow = {
  id: string;
  xodo_id: string;
  agency_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  continuity: boolean;
};

export async function runDueRoutines(deps: EngineDeps, limit = 5, opts: { deadline?: number } = {}) {
  const { sql } = deps;
  const now = deps.now ? deps.now() : new Date();
  const due = await sql.query<RoutineRow>(`select * from xodo_claim_due_routines($1::timestamptz, $2)`, [now.toISOString(), limit]);
  const results: { routineId: string; runId: string | null; status: string }[] = [];

  for (const routine of due) {
    // Agência suspensa pelo Spherum: a rotina não roda nem avisa; volta a valer quando reativarem.
    const ag = await one<{ suspended: boolean }>(sql, `select suspended_at is not null as suspended from agencies where id = $1`, [routine.agency_id]);
    if (ag?.suspended) { results.push({ routineId: routine.id, runId: null, status: "suspended" }); continue; }
    // Passado o prazo do cron, a rotina já reivindicada começa e segue em fatias.
    let runId: string | null = null;
    let status = "failed";
    let summary: string | null = null;
    try {
      runId = await startRun(deps, {
        xodoId: routine.xodo_id,
        agencyId: routine.agency_id,
        trigger: "routine",
        text: routine.prompt,
        routineId: routine.id,
      });
      status = await continueRun(deps, runId, { deadline: opts.deadline });
      // Só o que terminou vira resumo; uma pausa por teto ou uma falha não vale como "última execução" (e a fatia
      // que termina depois no cron grava o resumo por conta própria, em finish()).
      if (status === "completed") {
        const run = await one<{ final_text: string | null }>(sql, `select final_text from xodo_runs where id = $1`, [runId]);
        summary = run?.final_text?.slice(0, SUMMARY_MAX_CHARS) ?? null;
      }
    } catch (error) {
      const message = error instanceof XodoError ? error.message : "erro interno";
      if (!(error instanceof XodoError)) console.error("[xodos] rotina falhou", routine.id, error);
      await notify(sql, routine.agency_id, {
        kind: "routine_failed",
        title: `A rotina "${routine.name}" não rodou`,
        body: message,
        data: { routine_id: routine.id, xodo_id: routine.xodo_id },
      });
    }
    const after = deps.now ? deps.now() : new Date();
    await sql.query(
      `update xodo_routines
          set last_run_id = coalesce($2, last_run_id), last_run_at = $3::timestamptz,
              last_summary = case when continuity and $4::text is not null then $4::text else last_summary end,
              next_run_at = $5::timestamptz, locked_until = null
        where id = $1`,
      [routine.id, runId, after.toISOString(), summary, nextRunAt(routine.cron, routine.timezone, after)?.toISOString() ?? null],
    );
    results.push({ routineId: routine.id, runId, status });
  }
  return results;
}
