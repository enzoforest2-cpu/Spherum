import { one, parseJson } from "./db";
import { canAlwaysAllow, type Category } from "./policy";
import { addMessage, continueSlice, loadXodo, resumeRun, resumeTakeover, runAction, STALE_RUN_MS, XodoError, type EngineDeps } from "./runner";

/**
 * Decisões da equipe sobre os pedidos dos xodós (modelo do OpenDots).
 *
 * A decisão é uma troca atômica de "pending" para "approved" ou "denied": só a primeira
 * vale e pedidos vencidos não podem mais ser aprovados. Aprovado, o servidor executa o
 * input guardado (não o que vier na requisição) e retoma a execução quando o passo fecha.
 */

export type DecideInput = {
  actionId: string;
  agencyId: string;
  userId: string;
  approve: boolean;
  /** "always" também cria uma regra "sempre permitir" para esta ferramenta neste xodó. */
  scope?: "once" | "always";
  reason?: string;
  /** De onde veio a decisão: app (padrão), slack, whatsapp ou telegram. */
  via?: string;
};

type ActionRow = {
  id: string;
  run_id: string;
  xodo_id: string;
  tool_name: string;
  category: string;
  status: string;
  reason?: string | null;
  precondition?: unknown;
};

export async function decideAction(deps: EngineDeps, input: DecideInput) {
  const { sql } = deps;
  const now = (deps.now ? deps.now() : new Date()).toISOString();
  const wantsAlways = input.approve && input.scope === "always";

  const action = await sql.transaction(async (tx) => {
    const current = await one<ActionRow>(
      tx,
      `select id, run_id, xodo_id, tool_name, category, status, reason, precondition from xodo_actions where id = $1 and agency_id = $2`,
      [input.actionId, input.agencyId],
    );
    if (!current) throw new XodoError("Pedido não encontrado", 404);
    // "Sempre" não vale para o piso (nem o geral, nem o da ferramenta).
    const always = wantsAlways && canAlwaysAllow(current.category as Category) && current.reason !== "floor";
    const site = (parseJson<{ site?: unknown }>(current.precondition)?.site as string | undefined) ?? null;
    const decided = await one<ActionRow>(
      tx,
      `update xodo_actions
          set status = $3, decision = $4, decided_by = $5, decided_at = $6::timestamptz, reason = coalesce($7, reason),
              decided_via = $8
        where id = $1 and agency_id = $2 and status = 'pending' and (expires_at is null or expires_at > $6::timestamptz)
        returning id, run_id, xodo_id, tool_name, category, status`,
      [input.actionId, input.agencyId, input.approve ? "approved" : "denied", always ? "always" : "once",
        input.userId, now, input.reason?.slice(0, 500) ?? null, input.via ?? "app"],
    );
    if (!decided) return null;
    if (always) {
      await tx.query(
        `insert into approval_rules (agency_id, xodo_id, effect, match_kind, match_value, created_by)
         values ($1, $2, 'always_allow', $3, $4, $5)`,
        // Ação num site: o "sempre" vale só para aquele site.
        [input.agencyId, decided.xodo_id, site ? "site" : "tool", site ? `${decided.tool_name}@${site}` : decided.tool_name, input.userId],
      );
    }
    return { ...decided, alwaysCreated: always };
  });

  if (!action) {
    // Não decidiu: ou venceu, ou outra pessoa decidiu primeiro (a linha lida antes pode estar velha).
    const expired = await one(
      sql,
      `update xodo_actions set status = 'expired'
        where id = $1 and agency_id = $2 and status = 'pending' and expires_at <= $3::timestamptz returning id`,
      [input.actionId, input.agencyId, now],
    );
    const current = await one<{ status: string }>(sql, `select status from xodo_actions where id = $1`, [input.actionId]);
    if (expired || current?.status === "expired") throw new XodoError("Este pedido expirou.", 410);
    throw new XodoError("Este pedido já foi decidido.", 409);
  }

  if (action.status === "approved") {
    const claimed = await one(
      sql,
      `update xodo_actions set status = 'executing' where id = $1 and status = 'approved' returning id`,
      [action.id],
    );
    if (claimed) await runAction(deps, await loadXodo(sql, action.xodo_id, input.agencyId), action.id);
  }
  const final = await one<{ status: string; result: unknown }>(sql, `select status, result from xodo_actions where id = $1`, [action.id]);
  return { actionId: action.id, runId: action.run_id, status: final!.status, alwaysRuleCreated: action.alwaysCreated };
}

/**
 * Faxina chamada pelo cron: vence pedidos sem resposta (e retoma as execuções, para o xodó
 * avisar que nada foi feito) e marca como falha execuções travadas no meio.
 */
/** Quanto uma execução espera alguém assumir o computador antes de seguir sem isso. */
export const TAKEOVER_WAIT_MS = 24 * 60 * 60 * 1000;

export async function sweep(deps: EngineDeps) {
  const { sql } = deps;
  const now = deps.now ? deps.now() : new Date();
  const expired = await sql.query<{ run_id: string }>(
    `update xodo_actions set status = 'expired'
      where status = 'pending' and expires_at <= $1::timestamptz
      returning run_id`,
    [now.toISOString()],
  );
  // Retoma toda execução cujo passo já fechou (inclui pedidos vencidos ao tentar aprovar
  // e retomadas que falharam depois de uma decisão).
  const ready = await sql.query<{ id: string }>(
    `select r.id from xodo_runs r
      where r.status = 'waiting_approval'
        and not exists (
          select 1 from xodo_actions a
           where a.run_id = r.id and a.step = r.steps and a.status in ('pending', 'approved', 'executing'))
      order by r.started_at limit 20`,
  );
  const runs = ready.map((r) => r.id);
  for (const runId of runs) await resumeRun(deps, runId);

  const stale = await sql.query<{ id: string; xodo_id: string; agency_id: string }>(
    `update xodo_runs set status = 'failed', error = 'A execução parou no meio e foi encerrada.', finished_at = $1::timestamptz
      where status = 'running' and heartbeat_at < $2::timestamptz and slice_due_at is null
        and not exists (select 1 from xodo_actions a where a.run_id = xodo_runs.id and a.status = 'executing')
      returning id, xodo_id, agency_id`,
    [now.toISOString(), new Date(now.getTime() - 3 * STALE_RUN_MS).toISOString()],
  );
  // Quem pediu fica sabendo (num canal, a nota vai pela fila de entrega).
  for (const run of stale) {
    await addMessage(sql, { id: run.xodo_id, agency_id: run.agency_id }, run.id, "note", "Não consegui terminar: a execução parou no meio e foi encerrada. Pode pedir de novo?", null);
  }
  // Fatias que ninguém continuou (a chamada encadeada falhou): o cron continua.
  const slices = await sql.query<{ id: string }>(
    `select id from xodo_runs where status = 'running' and slice_due_at <= $1::timestamptz order by slice_due_at limit 10`,
    [new Date(now.getTime() - 60_000).toISOString()],
  );
  for (const run of slices) await continueSlice(deps, run.id, { deadline: Date.now() + 120_000 });
  // Pediu o computador e ninguém assumiu em um dia: o xodó segue sem contar com isso. Quem está
  // no controle tem o próprio prazo (o cron do computador vence o lease e retoma).
  const forgotten = await sql.query<{ id: string }>(
    `select r.id from xodo_runs r
      where r.status = 'waiting_takeover' and r.heartbeat_at < $1::timestamptz
        and not exists (select 1 from computers c where c.control_run_id = r.id)
      order by r.heartbeat_at limit 10`,
    [new Date(now.getTime() - TAKEOVER_WAIT_MS).toISOString()],
  );
  for (const run of forgotten) await resumeTakeover(deps, run.id, "expired").catch((error) => console.error("[xodos] retomada falhou", run.id, error));
  return {
    expiredActions: expired.length,
    resumedRuns: runs.length,
    staleRuns: stale.length,
    continuedSlices: slices.length,
    expiredTakeovers: forgotten.length,
  };
}
