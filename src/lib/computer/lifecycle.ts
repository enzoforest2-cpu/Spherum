import { z } from "zod";
import { dayIn } from "../xodos/budget";
import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { usdBrl } from "../xodos/fx";
import { redactSecrets } from "../xodos/redact";
import { credentialAad, openSecret } from "../xodos/vault";
import { PREPARE_TIMEOUT_MS, prepareMachine, RUNTIME_VERSION } from "./desktop";
import type { ComputerStorage, ProviderFactory, ProviderId, SandboxProvider } from "./provider";

/**
 * Ciclo de vida da máquina de cada agência (ideia do Rakazo, com o estado no Postgres porque a
 * Vercel não guarda memória entre chamadas):
 *
 *   none → provisioning → running ⇄ paused (passando por pausing/resuming) → destroying → destroyed
 *
 * Toda transição é uma troca atômica com fence (+1). Uma transição presa há mais de 2 minutos
 * pode ser retomada por outra chamada. O provedor pausa sozinho depois de idle_ms sem atividade
 * (expires_at = última atividade + idle_ms), então o banco sabe quando a máquina passou a contar
 * como pausada sem perguntar ao provedor.
 */

export type ComputerRow = {
  id: string;
  agency_id: string;
  provider: ProviderId;
  credential_id: string | null;
  provider_ref: string | null;
  runtime_version: string | null;
  state: "none" | "provisioning" | "running" | "pausing" | "paused" | "resuming" | "destroying" | "destroyed" | "error";
  generation: number;
  fence: number;
  transition_at: Date | string | null;
  last_activity_at: Date | string | null;
  expires_at: Date | string | null;
  session_started_at: Date | string | null;
  idle_ms: number;
  daily_hours_cap: number | string;
  egress_mode: "aberto" | "restrito";
  screen_run_id: string | null;
  screen_fence: number;
  screen_expires_at: Date | string | null;
  control_user_id: string | null;
  control_lease_id: string | null;
  control_fence: number;
  control_token_hash: string | null;
  control_started_at: Date | string | null;
  control_expires_at: Date | string | null;
  control_run_id: string | null;
  error: string | null;
};

export type ComputerDeps = {
  sql: Sql;
  now?: () => Date;
  masterKey: string;
  /** Provedores disponíveis (em produção E2B e Daytona; nos testes, o fake). */
  providers: Partial<Record<ProviderId, ProviderFactory>>;
  /** Chave do Spherum por provedor, para quando a agência não tem a própria (add-on). */
  spherumKeys?: Partial<Record<ProviderId, string>>;
  /** Bucket privado para anexos e arquivos da pessoa. */
  storage?: ComputerStorage;
};

export type RunningComputer = { computer: ComputerRow; provider: SandboxProvider; ref: string };

export const TRANSITION_STALE_MS = 2 * 60 * 1000;
export const MAX_SESSION_MS = 2 * 60 * 60 * 1000;
/** Custo aproximado por hora ligada (2 vCPU, 4 GiB); ajuste por variável de ambiente. */
const USD_PER_HOUR: Record<ProviderId, number> = { e2b: 0.17, daytona: 0.17, fake: 0 };
const COST_TZ = "America/Sao_Paulo";

const nowOf = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());
const time = (value: Date | string | null) => (value ? new Date(value).getTime() : 0);

function normalize(row: ComputerRow): ComputerRow {
  return {
    ...row,
    generation: Number(row.generation),
    fence: Number(row.fence),
    screen_fence: Number(row.screen_fence),
    control_fence: Number(row.control_fence),
    idle_ms: Number(row.idle_ms),
  };
}

export async function loadComputer(sql: Sql, agencyId: string): Promise<ComputerRow | null> {
  const row = await one<ComputerRow>(sql, `select * from computers where agency_id = $1`, [agencyId]);
  return row ? normalize(row) : null;
}

/** Registro na linha do tempo (o resumo passa pela limpeza de dados sensíveis). */
export async function logEvent(
  sql: Sql,
  e: {
    agencyId: string;
    computerId?: string | null;
    kind: string;
    status?: "pending" | "succeeded" | "failed" | "denied";
    summary?: string | null;
    xodoId?: string | null;
    runId?: string | null;
    actionId?: string | null;
    userId?: string | null;
  },
): Promise<string> {
  const row = await one<{ id: string }>(
    sql,
    `insert into computer_events (agency_id, computer_id, xodo_id, run_id, action_id, user_id, kind, status, summary, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $8 = 'pending' then null else now() end) returning id`,
    [e.agencyId, e.computerId ?? null, e.xodoId ?? null, e.runId ?? null, e.actionId ?? null, e.userId ?? null, e.kind,
      e.status ?? "succeeded", e.summary ? redactSecrets(e.summary).text.slice(0, 200) : null],
  );
  return row!.id;
}

export async function finishEvent(sql: Sql, id: string, status: "succeeded" | "failed" | "denied", summary?: string | null) {
  await sql.query(`update computer_events set status = $2, summary = coalesce($3, summary), finished_at = now() where id = $1`, [
    id,
    status,
    summary ? redactSecrets(summary).text.slice(0, 200) : null,
  ]);
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

export const computerInput = z.object({
  provider: z.enum(["e2b", "daytona"]),
  credential_id: z.uuid().nullable().optional(),
  // Mínimo de 5 minutos: um comando ou a leitura de um arquivo grande cabe antes da pausa.
  idle_minutes: z.number().int().min(5).max(60).optional(),
  daily_hours_cap: z.number().min(0.25).max(24).optional(),
  egress_mode: z.enum(["aberto", "restrito"]).optional(),
});

/** Escolhe o provedor e a chave da máquina da agência (e os limites). */
export async function configureComputer(deps: ComputerDeps, agencyId: string, raw: unknown): Promise<ComputerRow> {
  const input = computerInput.parse(raw);
  const { sql } = deps;
  if (input.credential_id) {
    const cred = await one(
      sql,
      `select 1 from ai_credentials where id = $1 and agency_id = $2 and kind = 'sandbox' and provider = $3 and revoked_at is null`,
      [input.credential_id, agencyId, input.provider],
    );
    if (!cred) throw new XodoError(`Chave de ${input.provider === "e2b" ? "E2B" : "Daytona"} não encontrada nesta agência.`, 404);
  } else if (!deps.spherumKeys?.[input.provider]) {
    throw new XodoError("Cadastre a chave do provedor da máquina em Cérebros e chaves.");
  }
  const current = await loadComputer(sql, agencyId);
  const live = current && !["none", "destroyed"].includes(current.state);
  if (live && current.provider !== input.provider) {
    throw new XodoError("Destrua a máquina atual antes de trocar de provedor.", 409);
  }
  const row = await one<ComputerRow>(
    sql,
    `insert into computers (agency_id, provider, credential_id, idle_ms, daily_hours_cap, egress_mode)
     values ($1, $2, $3, coalesce($4::integer, 600000), coalesce($5::numeric, 4), coalesce($6::text, 'aberto'))
     on conflict (agency_id) do update set
       provider = excluded.provider,
       credential_id = excluded.credential_id,
       idle_ms = coalesce($4::integer, computers.idle_ms),
       daily_hours_cap = coalesce($5::numeric, computers.daily_hours_cap),
       egress_mode = coalesce($6::text, computers.egress_mode),
       updated_at = now()
     returning *`,
    [agencyId, input.provider, input.credential_id ?? null, input.idle_minutes ? input.idle_minutes * 60_000 : null,
      input.daily_hours_cap ?? null, input.egress_mode ?? null],
  );
  return normalize(row!);
}

async function providerFor(deps: ComputerDeps, row: ComputerRow): Promise<SandboxProvider> {
  const factory = deps.providers[row.provider];
  if (!factory) throw new XodoError(`O provedor ${row.provider} não está disponível.`, 503);
  if (row.credential_id) {
    const cred = await one<{ ciphertext: string }>(
      deps.sql,
      `select ciphertext from ai_credentials where id = $1 and agency_id = $2 and kind = 'sandbox' and revoked_at is null`,
      [row.credential_id, row.agency_id],
    );
    if (!cred) throw new XodoError("A chave da máquina foi removida. Cadastre outra em Cérebros e chaves.", 409);
    return factory(await openSecret(cred.ciphertext, credentialAad(row.agency_id, row.credential_id), deps.masterKey));
  }
  const key = deps.spherumKeys?.[row.provider];
  if (!key) throw new XodoError("Cadastre a chave do provedor da máquina em Cérebros e chaves.", 409);
  return factory(key);
}

// ---------------------------------------------------------------------------
// Transições
// ---------------------------------------------------------------------------

/** Troca atômica de estado; nula se outra chamada mudou antes (estado ou fence diferentes). */
async function transition(
  sql: Sql,
  row: ComputerRow,
  to: ComputerRow["state"],
  now: Date,
  sets: Record<string, unknown> = {},
): Promise<ComputerRow | null> {
  const keys = Object.keys(sets);
  const extra = keys.map((k, i) => `, ${k} = $${i + 5}`).join("");
  const updated = await one<ComputerRow>(
    sql,
    `update computers set state = $3, fence = fence + 1, transition_at = $4::timestamptz, updated_at = now()${extra}
      where id = $1 and fence = $2 returning *`,
    [row.id, row.fence, to, now.toISOString(), ...keys.map((k) => sets[k])],
  );
  return updated ? normalize(updated) : null;
}

/** Segundos ligados hoje (sessões fechadas e a aberta). */
async function secondsToday(sql: Sql, row: ComputerRow, now: Date): Promise<number> {
  const day = dayIn(COST_TZ, now);
  const r = await one<{ closed: string; open_started: Date | string | null }>(
    sql,
    `select coalesce(sum(seconds) filter (where ended_at is not null), 0) as closed,
            max(started_at) filter (where ended_at is null) as open_started
       from computer_sessions where computer_id = $1 and (started_at at time zone '${COST_TZ}')::date = $2::date`,
    [row.id, day],
  );
  const open = r?.open_started ? Math.max(0, (now.getTime() - time(r.open_started)) / 1000) : 0;
  return num(r?.closed ?? 0) + open;
}

async function assertHoursLeft(sql: Sql, row: ComputerRow, now: Date) {
  const cap = num(row.daily_hours_cap) * 3600;
  if ((await secondsToday(sql, row, now)) >= cap) {
    throw new XodoError(`O computador já usou as ${num(row.daily_hours_cap)} horas de hoje. Amanhã ele volta (ou aumente o teto).`, 429);
  }
}

async function openSession(sql: Sql, row: ComputerRow, now: Date) {
  await sql.query(
    `insert into computer_sessions (agency_id, computer_id, provider, started_at) values ($1, $2, $3, $4::timestamptz)
     on conflict (computer_id) where ended_at is null do nothing`,
    [row.agency_id, row.id, row.provider, now.toISOString()],
  );
}

/** Fecha a sessão aberta com o tempo e o custo (em reais pela PTAX do dia). */
export async function closeSession(sql: Sql, row: Pick<ComputerRow, "id" | "provider">, endedAt: Date) {
  const open = await one<{ id: string; started_at: Date | string }>(
    sql,
    `select id, started_at from computer_sessions where computer_id = $1 and ended_at is null`,
    [row.id],
  );
  if (!open) return;
  const seconds = Math.max(0, Math.round((endedAt.getTime() - time(open.started_at)) / 1000));
  const perHour = Number(process.env[`COMPUTER_USD_PER_HOUR_${row.provider.toUpperCase()}`] ?? USD_PER_HOUR[row.provider]);
  const costUsd = Math.round((seconds / 3600) * perHour * 1e6) / 1e6;
  const rate = await usdBrl(sql, dayIn(COST_TZ, endedAt));
  await sql.query(
    `update computer_sessions set ended_at = $2::timestamptz, seconds = $3, cost_usd = $4, usd_brl = $5, cost_brl = $6 where id = $1`,
    [open.id, endedAt.toISOString(), seconds, costUsd, rate, rate === null ? null : Math.round(costUsd * rate * 1e4) / 1e4],
  );
}

const STARTING = "O computador está ligando. Tente de novo em instantes.";

/**
 * Garante a máquina ligada para uma ferramenta ou rota: estende se já está ligada, retoma se
 * pausou, cria (e prepara) se não existe ou sumiu. Respeita o teto de horas do dia.
 */
export async function ensureRunning(deps: ComputerDeps, agencyId: string): Promise<RunningComputer> {
  const { sql } = deps;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = nowOf(deps);
    const row = await loadComputer(sql, agencyId);
    if (!row) throw new XodoError("O computador da agência ainda não foi configurado.", 409);
    const stale = now.getTime() - time(row.transition_at) > TRANSITION_STALE_MS;
    const provider = await providerFor(deps, row);

    if (row.state === "running" && row.provider_ref && time(row.expires_at) > now.getTime()) {
      try {
        await provider.extend(row.provider_ref, row.idle_ms);
      } catch (error) {
        if (!provider.isGone(error)) throw error;
        if (await transition(sql, row, "none", now, { provider_ref: null })) await closeSession(sql, row, now);
        continue;
      }
      const touched = await one<ComputerRow>(
        sql,
        `update computers set last_activity_at = $2::timestamptz, expires_at = $3::timestamptz, updated_at = now()
          where id = $1 and fence = $4 returning *`,
        [row.id, now.toISOString(), new Date(now.getTime() + row.idle_ms).toISOString(), row.fence],
      );
      if (!touched) continue;
      return { computer: normalize(touched), provider, ref: row.provider_ref };
    }

    // Pausada (ou "ligada" mas já passou do prazo: o provedor pausou sozinho).
    const pausedNow = (row.state === "running" && time(row.expires_at) <= now.getTime()) || row.state === "paused";
    const retakeResume = row.state === "resuming" && stale;
    if ((pausedNow || retakeResume) && row.provider_ref) {
      // A sessão que passou do prazo fecha antes de conferir o teto (senão conta o tempo parada).
      if (row.state === "running") {
        const settled = await transition(sql, row, "paused", now, { screen_run_id: null, screen_expires_at: null });
        if (!settled) continue;
        await closeSession(sql, row, new Date(time(row.expires_at)));
        continue;
      }
      await assertHoursLeft(sql, row, now);
      const claimed = await transition(sql, row, "resuming", now);
      if (!claimed) continue;
      try {
        await provider.resume(row.provider_ref, row.idle_ms);
      } catch (error) {
        if (!provider.isGone(error)) {
          // Falha passageira: continua pausada com a mesma máquina (nada de recriar e perder os arquivos).
          await transition(sql, claimed, "paused", nowOf(deps), { error: safeError(error) });
          throw new XodoError("Não consegui retomar o computador. Tente de novo em instantes.", 502);
        }
        // Sumiu: recria do zero.
        await transition(sql, claimed, "none", nowOf(deps), { provider_ref: null });
        continue;
      }
      const running = await transition(sql, claimed, "running", nowOf(deps), {
        last_activity_at: now.toISOString(),
        expires_at: new Date(now.getTime() + row.idle_ms).toISOString(),
        session_started_at: now.toISOString(),
        error: null,
      });
      if (!running) continue;
      await openSession(sql, running, now);
      await logEvent(sql, { agencyId, computerId: row.id, kind: "retomar" });
      // O preparo mudou desde a última vez (scripts novos no deploy): prepara de novo.
      if (running.runtime_version !== RUNTIME_VERSION) {
        await provider.extend(row.provider_ref, Math.max(row.idle_ms, PREPARE_TIMEOUT_MS + 60_000));
        await prepareMachine(provider, row.provider_ref, { egressMode: row.egress_mode });
        await provider.extend(row.provider_ref, row.idle_ms);
        await sql.query(`update computers set runtime_version = $2 where id = $1`, [row.id, RUNTIME_VERSION]);
        running.runtime_version = RUNTIME_VERSION;
      }
      return { computer: running, provider, ref: row.provider_ref };
    }

    const needsMachine =
      ["none", "destroyed", "error"].includes(row.state) ||
      (row.state === "provisioning" && stale) ||
      (["running", "paused"].includes(row.state) && !row.provider_ref);
    if (needsMachine) {
      await assertHoursLeft(sql, row, now);
      const claimed = await transition(sql, row, "provisioning", now, { generation: row.generation + 1, error: null });
      if (!claimed) continue;
      // Máquina de uma criação que falhou (ou ficou presa no meio): não tem nada da agência, sai.
      if (row.provider_ref) await provider.destroy(row.provider_ref).catch(() => undefined);
      let ref: string;
      try {
        // Prazo do provedor cobre o preparo (a primeira vez instala pacotes); depois volta ao da agência.
        const idleMs = Math.max(row.idle_ms, PREPARE_TIMEOUT_MS + 60_000);
        ({ ref } = await provider.create({ agencyId, computerId: row.id, generation: claimed.generation, idleMs }));
        // Guarda o id já: se a função morrer no preparo, a próxima chamada destrói a máquina.
        await sql.query(`update computers set provider_ref = $2 where id = $1 and fence = $3`, [row.id, ref, claimed.fence]);
        await prepareMachine(provider, ref, { egressMode: row.egress_mode });
        await provider.extend(ref, row.idle_ms);
      } catch (error) {
        await transition(sql, claimed, "error", nowOf(deps), { error: safeError(error) });
        await logEvent(sql, { agencyId, computerId: row.id, kind: "criar", status: "failed", summary: safeError(error) });
        throw new XodoError("Não consegui ligar o computador. Confira a chave do provedor e tente de novo.", 502);
      }
      const done = nowOf(deps);
      const running = await transition(sql, claimed, "running", done, {
        provider_ref: ref,
        runtime_version: RUNTIME_VERSION,
        last_activity_at: done.toISOString(),
        expires_at: new Date(done.getTime() + row.idle_ms).toISOString(),
        session_started_at: done.toISOString(),
      });
      if (!running) continue;
      await openSession(sql, running, done);
      await logEvent(sql, { agencyId, computerId: row.id, kind: "criar", summary: `máquina ${running.generation} pronta` });
      return { computer: running, provider, ref };
    }

    if (["pausing", "destroying"].includes(row.state) && stale) {
      await settleStuck(deps, row, provider);
      continue;
    }
    throw new XodoError(row.state === "destroying" ? "O computador está sendo desligado de vez." : STARTING, 409);
  }
  throw new XodoError(STARTING, 409);
}

/**
 * Transição presa (a função morreu no meio de pausar ou apagar): tenta de novo no provedor e
 * fecha a sessão. Se o provedor falhar, fica como está e a próxima chamada (ou o cron) tenta.
 */
async function settleStuck(deps: ComputerDeps, row: ComputerRow, provider: SandboxProvider) {
  const { sql } = deps;
  const now = nowOf(deps);
  if (row.provider_ref) {
    try {
      await (row.state === "pausing" ? provider.pause(row.provider_ref) : provider.destroy(row.provider_ref));
    } catch (error) {
      if (!provider.isGone(error)) return;
    }
  }
  const settled =
    row.state === "pausing"
      ? await transition(sql, row, "paused", now, { screen_run_id: null, screen_expires_at: null })
      : await transition(sql, row, "destroyed", now, { provider_ref: null, screen_run_id: null, screen_expires_at: null });
  if (settled) await closeSession(sql, row, new Date(time(row.transition_at) || now.getTime()));
}

/** Pausa a máquina (o disco e, no E2B, a memória ficam guardados). */
export async function pauseComputer(deps: ComputerDeps, agencyId: string, reason = "pausar"): Promise<ComputerRow | null> {
  const { sql } = deps;
  const now = nowOf(deps);
  const row = await loadComputer(sql, agencyId);
  if (!row || row.state !== "running" || !row.provider_ref) return row;
  const provider = await providerFor(deps, row);
  const claimed = await transition(sql, row, "pausing", now);
  if (!claimed) return loadComputer(sql, agencyId);
  try {
    await provider.pause(row.provider_ref);
  } catch (error) {
    if (!provider.isGone(error)) {
      // Não pausou: continua ligada (e contando), e a próxima pausa tenta de novo.
      await transition(sql, claimed, "running", nowOf(deps), { error: safeError(error) });
      throw error;
    }
  }
  const paused = await transition(sql, claimed, "paused", nowOf(deps), { screen_run_id: null, screen_expires_at: null });
  await closeSession(sql, row, now);
  await logEvent(sql, { agencyId, computerId: row.id, kind: reason });
  return paused;
}

/** Desliga de vez e apaga a máquina (os arquivos e logins de lá se perdem). */
export async function destroyComputer(deps: ComputerDeps, agencyId: string, userId: string | null): Promise<void> {
  const { sql } = deps;
  const now = nowOf(deps);
  const row = await loadComputer(sql, agencyId);
  if (!row || row.state === "destroyed" || row.state === "none") return;
  const provider = row.provider_ref ? await providerFor(deps, row) : null;
  const claimed = await transition(sql, row, "destroying", now);
  if (!claimed) throw new XodoError("O computador mudou de estado agora. Tente de novo.", 409);
  if (row.provider_ref && provider) {
    try {
      await provider.destroy(row.provider_ref);
    } catch (error) {
      if (!provider.isGone(error)) {
        await transition(sql, claimed, row.state, nowOf(deps), { error: safeError(error) });
        throw new XodoError("Não consegui apagar a máquina no provedor. Tente de novo em instantes.", 502);
      }
    }
  }
  await transition(sql, claimed, "destroyed", nowOf(deps), {
    provider_ref: null,
    screen_run_id: null,
    screen_expires_at: null,
    control_user_id: null,
    control_lease_id: null,
    control_token_hash: null,
    control_expires_at: null,
    control_run_id: null,
  });
  await closeSession(sql, row, now);
  await logEvent(sql, { agencyId, computerId: row.id, kind: "destruir", userId });
}

/**
 * Cron: dá como pausadas as máquinas que passaram do prazo (o provedor já pausou), pausa sessões
 * longas demais sem ninguém no controle, termina pausas e exclusões presas e limpa fotos de página
 * e eventos antigos.
 */
export async function sweepComputers(deps: ComputerDeps) {
  const { sql } = deps;
  const now = nowOf(deps);
  const expired = await sql.query<ComputerRow>(
    `select * from computers where state = 'running' and expires_at <= $1::timestamptz`,
    [now.toISOString()],
  );
  for (const row of expired.map(normalize)) {
    const paused = await transition(sql, row, "paused", now, { screen_run_id: null, screen_expires_at: null });
    if (paused) await closeSession(sql, row, new Date(time(row.expires_at)));
  }
  const long = await sql.query<ComputerRow>(
    `select * from computers where state = 'running' and session_started_at <= $1::timestamptz
        and (control_expires_at is null or control_expires_at <= $2::timestamptz)`,
    [new Date(now.getTime() - MAX_SESSION_MS).toISOString(), now.toISOString()],
  );
  for (const row of long) await pauseComputer(deps, row.agency_id, "pausar_sessao_longa").catch(() => undefined);
  // Pausar ou apagar que ficou no meio. (O controle vencido é do expireControls, que retoma a execução.)
  const stuck = await sql.query<ComputerRow>(
    `select * from computers where state in ('pausing', 'destroying') and transition_at <= $1::timestamptz`,
    [new Date(now.getTime() - TRANSITION_STALE_MS).toISOString()],
  );
  for (const row of stuck.map(normalize)) {
    const provider = await providerFor(deps, row).catch(() => null);
    if (provider) await settleStuck(deps, row, provider);
  }
  await sql.query(
    `update computers set screen_run_id = null, screen_expires_at = null where screen_expires_at is not null and screen_expires_at <= $1::timestamptz`,
    [now.toISOString()],
  );
  await sql.query(`delete from computer_snapshots where created_at < $1::timestamptz`, [new Date(now.getTime() - 3_600_000).toISOString()]);
  await sql.query(`delete from computer_events where created_at < $1::timestamptz`, [new Date(now.getTime() - 90 * 86_400_000).toISOString()]);
  return { paused: expired.length, longSessions: long.length, stuck: stuck.length };
}

/** Mensagem de erro do provedor sem detalhes que possam carregar chaves (fica no banco e nos logs). */
export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).text.slice(0, 300);
}
