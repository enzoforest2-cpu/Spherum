import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dayIn } from "../xodos/budget";
import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { usdBrl } from "../xodos/fx";
import { credentialAad, lastFour, sealSecret } from "../xodos/vault";
import { controlHolder, forceRelease, type ControlDeps } from "./control";
import { configureComputer, destroyComputer, ensureRunning, loadComputer, logEvent, pauseComputer, type ComputerDeps, type ComputerRow } from "./lifecycle";
import type { ProviderId } from "./provider";

/**
 * O que as rotas do computador fazem: estado do card, configuração, ligar, pausar e destruir,
 * linha do tempo, regras de site e chaves de máquina (E2B, Daytona). Nada daqui devolve o id da
 * máquina no provedor, o hash do token de controle ou a chave em si.
 */

const COST_TZ = "America/Sao_Paulo";
/** Mesmo preço por hora do ciclo de vida (para estimar a sessão aberta). */
const USD_PER_HOUR: Record<ProviderId, number> = { e2b: 0.17, daytona: 0.17, fake: 0 };

const nowOf = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());
const time = (value: Date | string | null) => (value ? new Date(value).getTime() : 0);
const isoOf = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export type ComputerState = {
  configured: boolean;
  computer: {
    id: string;
    provider: ProviderId;
    credential_id: string | null;
    /** Estado efetivo: "running" com o prazo vencido já conta como "paused" (o provedor pausou). */
    state: ComputerRow["state"];
    live: boolean;
    generation: number;
    runtime_version: string | null;
    idle_minutes: number;
    daily_hours_cap: number;
    egress_mode: ComputerRow["egress_mode"];
    expires_at: string | null;
    error: string | null;
  } | null;
  usage_today: { hours: number; cost_brl: number | null; cost_usd: number; cap_hours: number } | null;
  /** Execução que está usando a tela agora. */
  screen: { run_id: string; xodo_id: string | null; xodo_name: string | null; expires_at: string | null } | null;
  /** Pessoa no controle agora (o lease só aparece para ela mesma, para o heartbeat). */
  control: { user_id: string; started_at: string | null; expires_at: string | null; run_id: string | null; mine: boolean; lease_id: string | null } | null;
  last_activity: { at: string | null; kind: string | null; summary: string | null; xodo_id: string | null };
  has_frame: boolean;
};

async function usageToday(sql: Sql, row: ComputerRow, now: Date) {
  const day = dayIn(COST_TZ, now);
  const r = await one<{ seconds: string; cost_usd: string; cost_brl: string | null; missing_brl: string; open_started: Date | string | null }>(
    sql,
    `select coalesce(sum(seconds) filter (where ended_at is not null), 0) as seconds,
            coalesce(sum(cost_usd) filter (where ended_at is not null), 0) as cost_usd,
            sum(cost_brl) filter (where ended_at is not null) as cost_brl,
            count(*) filter (where ended_at is not null and cost_brl is null and coalesce(cost_usd, 0) > 0) as missing_brl,
            max(started_at) filter (where ended_at is null) as open_started
       from computer_sessions where computer_id = $1 and (started_at at time zone '${COST_TZ}')::date = $2::date`,
    [row.id, day],
  );
  // Sessão aberta: até agora, mas não depois do prazo em que o provedor pausou sozinho.
  const openEnd = Math.min(now.getTime(), time(row.expires_at) || now.getTime());
  const openSeconds = r?.open_started ? Math.max(0, (openEnd - time(r.open_started)) / 1000) : 0;
  const perHour = Number(process.env[`COMPUTER_USD_PER_HOUR_${row.provider.toUpperCase()}`] ?? USD_PER_HOUR[row.provider]);
  const openUsd = (openSeconds / 3600) * perHour;
  const rate = await usdBrl(sql, day);
  const costUsd = num(r?.cost_usd) + openUsd;
  const closedBrl = r?.cost_brl === null || r?.cost_brl === undefined ? 0 : num(r.cost_brl);
  const unknownBrl = num(r?.missing_brl) > 0 || (openUsd > 0 && rate === null);
  return {
    hours: Math.round(((num(r?.seconds) + openSeconds) / 3600) * 100) / 100,
    cost_usd: Math.round(costUsd * 1e4) / 1e4,
    cost_brl: unknownBrl ? null : Math.round((closedBrl + openUsd * (rate ?? 0)) * 100) / 100,
    cap_hours: num(row.daily_hours_cap),
  };
}

/** Estado do card "Computador na nuvem" (AO VIVO / EM REPOUSO, usando agora, no controle). */
export async function getComputerState(deps: Pick<ComputerDeps, "sql" | "now">, agencyId: string, userId?: string): Promise<ComputerState> {
  const { sql } = deps;
  const now = nowOf(deps);
  const row = await loadComputer(sql, agencyId);
  const lastEvent = await one<{ kind: string; summary: string | null; created_at: Date | string; xodo_id: string | null }>(
    sql,
    `select kind, summary, created_at, xodo_id from computer_events where agency_id = $1 order by id desc limit 1`,
    [agencyId],
  );
  if (!row) {
    return {
      configured: false,
      computer: null,
      usage_today: null,
      screen: null,
      control: null,
      last_activity: { at: isoOf(lastEvent?.created_at ?? null), kind: lastEvent?.kind ?? null, summary: lastEvent?.summary ?? null, xodo_id: lastEvent?.xodo_id ?? null },
      has_frame: false,
    };
  }
  const live = row.state === "running" && time(row.expires_at) > now.getTime();
  const state = row.state === "running" && !live ? "paused" : row.state;
  let screen: ComputerState["screen"] = null;
  if (live && row.screen_run_id && time(row.screen_expires_at) > now.getTime()) {
    const who = await one<{ xodo_id: string; name: string }>(
      sql,
      `select r.xodo_id, x.name from xodo_runs r join xodos x on x.id = r.xodo_id where r.id = $1 and r.agency_id = $2`,
      [row.screen_run_id, agencyId],
    );
    screen = { run_id: row.screen_run_id, xodo_id: who?.xodo_id ?? null, xodo_name: who?.name ?? null, expires_at: isoOf(row.screen_expires_at) };
  }
  const holder = controlHolder(row, now);
  const control: ComputerState["control"] = holder
    ? {
        user_id: holder,
        started_at: isoOf(row.control_started_at),
        expires_at: isoOf(row.control_expires_at),
        run_id: row.control_run_id,
        mine: holder === userId,
        lease_id: holder === userId ? row.control_lease_id : null,
      }
    : null;
  const lastFrame = await one<{ has: boolean }>(sql, `select last_frame_path is not null as has from computers where id = $1`, [row.id]);
  const activityAt = Math.max(time(row.last_activity_at), time(lastEvent?.created_at ?? null));
  return {
    configured: true,
    computer: {
      id: row.id,
      provider: row.provider,
      credential_id: row.credential_id,
      state,
      live,
      generation: row.generation,
      runtime_version: row.runtime_version,
      idle_minutes: Math.round(row.idle_ms / 60_000),
      daily_hours_cap: num(row.daily_hours_cap),
      egress_mode: row.egress_mode,
      expires_at: live ? isoOf(row.expires_at) : null,
      error: row.error,
    },
    usage_today: await usageToday(sql, row, now),
    screen,
    control,
    last_activity: {
      at: activityAt ? new Date(activityAt).toISOString() : null,
      kind: lastEvent?.kind ?? null,
      summary: lastEvent?.summary ?? null,
      xodo_id: lastEvent?.xodo_id ?? null,
    },
    // Nenhuma captura é mostrada enquanto uma pessoa está no controle.
    has_frame: Boolean(lastFrame?.has) && !holder,
  };
}

// ---------------------------------------------------------------------------
// Configurar, ligar, pausar, destruir
// ---------------------------------------------------------------------------

export async function configure(deps: ComputerDeps, agencyId: string, userId: string, raw: unknown): Promise<ComputerState> {
  const row = await configureComputer(deps, agencyId, raw);
  await logEvent(deps.sql, { agencyId, computerId: row.id, kind: "configurar", userId, summary: `provedor ${row.provider}` });
  return getComputerState(deps, agencyId, userId);
}

export async function startComputer(deps: ComputerDeps, agencyId: string, userId: string): Promise<ComputerState> {
  const { computer } = await ensureRunning(deps, agencyId);
  await logEvent(deps.sql, { agencyId, computerId: computer.id, kind: "ligar", userId });
  return getComputerState(deps, agencyId, userId);
}

export async function stopComputer(deps: ComputerDeps, agencyId: string, userId: string): Promise<ComputerState> {
  const row = await loadComputer(deps.sql, agencyId);
  if (!row) throw new XodoError("O computador da agência ainda não foi configurado.", 409);
  const holder = controlHolder(row, nowOf(deps));
  if (holder && holder !== userId) throw new XodoError("Uma pessoa da equipe está usando o computador. Espere ela devolver o controle.", 409);
  if (holder) throw new XodoError("Devolva o controle antes de pausar o computador.", 409);
  await pauseComputer(deps, agencyId, "pausar");
  return getComputerState(deps, agencyId, userId);
}

/** Desliga de vez: encerra o controle de quem estiver lá e apaga a máquina. */
export async function destroy(deps: ControlDeps, agencyId: string, userId: string): Promise<void> {
  await forceRelease(deps, agencyId, userId);
  await destroyComputer(deps, agencyId, userId);
}

// ---------------------------------------------------------------------------
// Linha do tempo
// ---------------------------------------------------------------------------

export const eventsQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function listEvents(sql: Sql, agencyId: string, raw: unknown) {
  const q = eventsQuery.parse(raw ?? {});
  const rows = await sql.query<{
    id: string | number;
    kind: string;
    status: string;
    summary: string | null;
    xodo_id: string | null;
    run_id: string | null;
    action_id: string | null;
    user_id: string | null;
    created_at: Date | string;
    finished_at: Date | string | null;
  }>(
    `select id, kind, status, summary, xodo_id, run_id, action_id, user_id, created_at, finished_at
       from computer_events where agency_id = $1 and ($2::bigint is null or id < $2::bigint)
      order by id desc limit $3`,
    [agencyId, q.before ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit).map((r) => ({
    ...r,
    id: Number(r.id),
    created_at: isoOf(r.created_at),
    finished_at: isoOf(r.finished_at),
  }));
  return { events: page, next: rows.length > q.limit ? page[page.length - 1].id : null };
}

// ---------------------------------------------------------------------------
// Regras de site
// ---------------------------------------------------------------------------

const CATEGORIES = ["leitura", "alteracao", "envio", "exclusao", "pagamento", "campanha", "cliente", "so_voce"] as const;
const HOST = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Padrão de site: host ("business.facebook.com"), host com curinga só no começo
 * ("*.facebook.com") e, opcionalmente, um começo de caminho ("ads.google.com/aw").
 * Aceita colado com https://; sem usuário, senha, porta, consulta nem fragmento.
 */
export function normalizeSitePattern(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/^https?:\/\//, "");
  const slash = value.indexOf("/");
  const host = slash < 0 ? value : value.slice(0, slash);
  const path = slash < 0 ? "" : value.slice(slash).replace(/\/+$/, "");
  if (!HOST.test(host)) throw new XodoError(`Padrão de site inválido: ${raw.slice(0, 80)}`);
  if (path && !/^(\/[a-z0-9._~%-]+)+$/.test(path)) throw new XodoError(`Caminho inválido no padrão: ${raw.slice(0, 80)}`);
  const pattern = host + path;
  if (pattern.length > 200) throw new XodoError("Padrão de site longo demais.");
  return pattern;
}

export const siteRulesInput = z.object({
  rules: z
    .array(z.object({ pattern: z.string().trim().min(1).max(220), category: z.enum(CATEGORIES) }))
    .max(200),
});

export async function listSiteRules(sql: Sql, agencyId: string) {
  return sql.query<{ id: string; pattern: string; category: string; created_by: string | null; created_at: string }>(
    `select id, pattern, category, created_by, created_at::text from computer_site_rules where agency_id = $1 order by pattern`,
    [agencyId],
  );
}

/** Troca todas as regras de site da agência (uma por padrão). */
export async function setSiteRules(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const { rules } = siteRulesInput.parse(raw);
  const byPattern = new Map<string, string>();
  for (const r of rules) byPattern.set(normalizeSitePattern(r.pattern), r.category);
  await sql.transaction(async (tx) => {
    await tx.query(`delete from computer_site_rules where agency_id = $1`, [agencyId]);
    for (const [pattern, category] of byPattern) {
      await tx.query(`insert into computer_site_rules (agency_id, pattern, category, created_by) values ($1, $2, $3, $4)`, [
        agencyId,
        pattern,
        category,
        userId,
      ]);
    }
  });
  const computer = await loadComputer(sql, agencyId);
  await logEvent(sql, { agencyId, computerId: computer?.id ?? null, kind: "regras_site", userId, summary: `${byPattern.size} regra(s)` });
  return listSiteRules(sql, agencyId);
}

// ---------------------------------------------------------------------------
// Chaves de máquina (mesmo cofre e mesmo AAD das chaves de modelo)
// ---------------------------------------------------------------------------

export const sandboxKeyInput = z.object({
  provider: z.enum(["e2b", "daytona"]),
  label: z.string().trim().min(1).max(60),
  api_key: z.string().trim().min(8, "Cole a chave completa.").max(500).regex(/^\S+$/, "A chave não pode ter espaços."),
});

export type SandboxKey = { id: string; provider: string; label: string; key_last4: string; created_at?: string; revoked_at?: string | null };

export async function createSandboxKey(sql: Sql, agencyId: string, raw: unknown, createdBy: string | null, masterKey: string): Promise<SandboxKey> {
  const input = sandboxKeyInput.parse(raw);
  const id = randomUUID();
  const ciphertext = await sealSecret(input.api_key, credentialAad(agencyId, id), masterKey);
  const row = await one<SandboxKey>(
    sql,
    `insert into ai_credentials (id, agency_id, provider, label, ciphertext, key_last4, created_by, kind)
     values ($1, $2, $3, $4, $5, $6, $7, 'sandbox') returning id, provider, label, key_last4, created_at::text`,
    [id, agencyId, input.provider, input.label, ciphertext, lastFour(input.api_key), createdBy],
  );
  return row!;
}

export async function listSandboxKeys(sql: Sql, agencyId: string): Promise<SandboxKey[]> {
  return sql.query<SandboxKey>(
    `select id, provider, label, key_last4, created_at::text, revoked_at::text
       from ai_credentials where agency_id = $1 and kind = 'sandbox' order by created_at desc`,
    [agencyId],
  );
}
