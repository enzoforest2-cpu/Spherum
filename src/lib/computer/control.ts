// Ideias adaptadas do Rakazo (Apache-2.0: packages/adapters/src/takeover-resume.ts e linux-desktop.ts,
// tokens de tela e controle) e do OpenMausBot (Apache-2.0: pessoa no controle para o agente).
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { resumeTakeover, type EngineDeps } from "../xodos/runner";
import type { RunStatus } from "../xodos/types";
import { ensureRunning, loadComputer, logEvent, safeError, type ComputerDeps, type ComputerRow, type RunningComputer } from "./lifecycle";
import { shellQuote } from "./output";

/**
 * Pessoa no controle do computador. Uma por vez, com lease de 15 minutos renovado por heartbeat
 * (até 2 horas no total). Enquanto ela está lá, toda ferramenta do computador é recusada para
 * todos os xodós (o gateway confere control_user_id e control_expires_at).
 *
 * Tokens: o navegador fala direto com a máquina (a Vercel não faz proxy de WebSocket), pelo
 * websockify com TokenFile. O token vai no fragmento da URL; no banco fica só o sha256. Para
 * revogar, o servidor apaga o token e mata os processos de controle; o vigia da máquina faz o
 * mesmo sozinho no vencimento, mesmo que o cron atrase.
 *
 * Toda troca de dono passa por control_fence (troca atômica) e todo comando da máquina leva o
 * token em base64 dentro de aspas simples (nunca interpolado cru).
 */

export const CONTROL_LEASE_MS = 15 * 60 * 1000;
export const CONTROL_MAX_MS = 2 * 60 * 60 * 1000;
export const VIEW_TOKEN_MS = 15 * 60 * 1000;
/** Porta do gateway da tela (websockify com TokenFile); a única exposta da máquina. */
export const SCREEN_PORT = 6100;

// Contrato com o preparo da máquina (frente de provedores): pastas de root e scripts em /opt/spherum/bin.
/** Pasta lida pelo websockify (--token-source); um arquivo por grupo de tokens. */
export const TOKEN_DIR = "/run/spherum/tokens";
/** Vencimento de cada arquivo de token (epoch em segundos); o vigia apaga os vencidos. */
export const EXPIRY_DIR = "/run/spherum/expiry";
const STAGING_DIR = "/run/spherum/staging";
const VIEW_SOCKET = "/run/spherum/vnc-view.sock";
const CONTROL_SOCKET = "/run/spherum/vnc-control.sock";
const PTY_SOCKET = "/run/spherum/pty.sock";
/** x11vnc sem -viewonly no socket de controle (start/stop idempotentes). */
export const CONTROL_VNC_START = "/opt/spherum/bin/spherum-control-vnc start";
export const CONTROL_VNC_STOP = "/opt/spherum/bin/spherum-control-vnc stop";
/** Servidor PTY (bash do usuário xodo, no ambiente limpo) no socket do terminal. */
export const PTY_START = "/opt/spherum/bin/spherum-pty start";
export const PTY_STOP = "/opt/spherum/bin/spherum-pty stop";

export type ControlDeps = ComputerDeps & {
  /** Motor dos Xodós, para retomar a execução que esperava a pessoa. */
  engine?: EngineDeps;
  /** Adia a retomada para depois da resposta (after() nas rotas); sem isto, retoma na hora. */
  defer?: (runId: string, task: () => Promise<unknown>) => void;
};

export type ControlReason = "done" | "skipped" | "expired";
type Role = "owner" | "admin" | "member" | "viewer";

const CAN_TAKE: Role[] = ["owner", "admin", "member"];
const CAN_REVOKE: Role[] = ["owner", "admin"];

const nowOf = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());
const time = (value: Date | string | null) => (value ? new Date(value).getTime() : 0);
const iso = (ms: number) => new Date(ms).toISOString();

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

function heldBy(row: ComputerRow, now: Date): string | null {
  return row.control_user_id && time(row.control_expires_at) > now.getTime() ? row.control_user_id : null;
}

const isLive = (row: ComputerRow, now: Date) => row.state === "running" && Boolean(row.provider_ref) && time(row.expires_at) > now.getTime();

async function roleOf(sql: Sql, agencyId: string, userId: string): Promise<Role | null> {
  const row = await one<{ role: Role }>(sql, `select role from agency_members where agency_id = $1 and user_id = $2`, [agencyId, userId]);
  return row?.role ?? null;
}

async function requireComputer(sql: Sql, agencyId: string): Promise<ComputerRow> {
  const row = await loadComputer(sql, agencyId);
  if (!row) throw new XodoError("O computador da agência ainda não foi configurado.", 409);
  return row;
}

// ---------------------------------------------------------------------------
// Comandos da máquina (rodam como root; o token só chega em base64)
// ---------------------------------------------------------------------------

function epochSeconds(ms: number): number {
  const s = Math.floor(ms / 1000);
  if (!Number.isSafeInteger(s) || s <= 0) throw new Error("vencimento inválido");
  return s;
}

/** Grava um arquivo do TokenFile (troca atômica com mv) e o vencimento dele. */
function tokenFileScript(name: string, token: string, lines: { prefix: string; socket: string }[], expiresMs: number): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("nome de arquivo de token inválido");
  const epoch = epochSeconds(expiresMs);
  const body = lines.map((l) => `printf '%s-%s: unix_socket:%s\\n' ${shellQuote(l.prefix)} "$tok" ${shellQuote(l.socket)}`).join("\n  ");
  return [
    "set -eu",
    "umask 077",
    `mkdir -p ${TOKEN_DIR} ${EXPIRY_DIR} ${STAGING_DIR}`,
    `chmod 700 ${TOKEN_DIR} ${EXPIRY_DIR} ${STAGING_DIR}`,
    `tok=$(printf '%s' ${shellQuote(b64(token))} | base64 -d)`,
    // Só o alfabeto do token: nada de quebra de linha ou dois-pontos no TokenFile.
    `case "$tok" in ''|*[!A-Za-z0-9_-]*) echo 'token inválido' >&2; exit 64;; esac`,
    "{",
    `  ${body}`,
    `} > ${STAGING_DIR}/${name}`,
    `printf '%s\\n' ${epoch} > ${EXPIRY_DIR}/${name}`,
    `mv -f ${STAGING_DIR}/${name} ${TOKEN_DIR}/${name}`,
  ].join("\n");
}

const CONTROL_LINES = [
  { prefix: "c", socket: CONTROL_SOCKET },
  { prefix: "t", socket: PTY_SOCKET },
];

/** Grava os tokens de controle (c-) e terminal (t-) e sobe de novo o VNC de controle e o PTY. */
export function startControlScript(token: string, expiresMs: number): string {
  return [
    tokenFileScript("control", token, CONTROL_LINES, expiresMs),
    // Reinicia: quem estava conectado antes (outra pessoa, revogada) cai na hora.
    `${CONTROL_VNC_STOP} || true`,
    `${PTY_STOP} || true`,
    CONTROL_VNC_START,
    PTY_START,
  ].join("\n");
}

/** Troca só o token de controle (a conexão aberta continua). */
export function rotateControlScript(token: string, expiresMs: number): string {
  return tokenFileScript("control", token, CONTROL_LINES, expiresMs);
}

/** Apaga os tokens de controle e mata o VNC de controle e o PTY: a conexão cai na hora. */
export function stopControlScript(): string {
  return [`rm -f ${TOKEN_DIR}/control ${EXPIRY_DIR}/control ${STAGING_DIR}/control`, `${CONTROL_VNC_STOP} || true`, `${PTY_STOP} || true`].join("\n");
}

/** Adia o vencimento do controle na máquina (heartbeat). */
export function extendControlScript(expiresMs: number): string {
  const epoch = epochSeconds(expiresMs);
  return [`set -eu`, `test -f ${TOKEN_DIR}/control`, `printf '%s\\n' ${epoch} > ${EXPIRY_DIR}/control`].join("\n");
}

/** Token de assistir (só leitura, no VNC -viewonly que fica sempre ligado). */
export function viewTokenScript(id: string, token: string, expiresMs: number): string {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("id de token inválido");
  return tokenFileScript(`view-${id}`, token, [{ prefix: "v", socket: VIEW_SOCKET }], expiresMs);
}

async function rootRun(machine: RunningComputer, script: string) {
  const r = await machine.provider.run(machine.ref, { script, user: "root", timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`comando de controle saiu com ${r.code}`);
}

/** Endereço do gateway da tela, sempre em https. */
async function screenBase(machine: RunningComputer): Promise<string> {
  const raw = (await machine.provider.publicUrl(machine.ref, SCREEN_PORT)).trim().replace(/\/+$/, "");
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  url.protocol = "https:";
  return url.toString().replace(/\/+$/, "");
}

const pageUrl = (base: string, page: "view.html" | "terminal.html", token: string) => `${base}/${page}#t=${token}`;

// ---------------------------------------------------------------------------
// Link de devolução (uso único, sem estado): HMAC preso ao lease. Quando o lease acaba (pelo
// link, pela pessoa, por vencimento ou por outra pessoa assumindo), o link deixa de valer.
// ---------------------------------------------------------------------------

function releaseMac(masterKey: string, leaseId: string): string {
  return createHmac("sha256", masterKey).update(`spherum:computer-release:${leaseId}`).digest("base64url");
}

export function releaseToken(masterKey: string, leaseId: string): string {
  return `${leaseId}.${releaseMac(masterKey, leaseId)}`;
}

function leaseFromReleaseToken(masterKey: string, token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token.trim());
  if (!m) return null;
  const expected = Buffer.from(releaseMac(masterKey, m[1]));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Assumir, renovar, devolver
// ---------------------------------------------------------------------------

export type ControlGrant = {
  leaseId: string;
  expiresAt: string;
  runId: string | null;
  viewUrl: string;
  terminalUrl: string;
  /** Token do link de devolução (POST /api/xodos/computer/release-link). */
  releaseToken: string;
  /** Pessoa que estava no controle e foi revogada por um admin. */
  revokedUserId: string | null;
};

/** Execução da agência que a pessoa vai atender: a que espera por ela, ou a que está com a tela. */
async function runToServe(sql: Sql, row: ComputerRow, now: Date): Promise<string | null> {
  if (row.control_run_id) {
    const kept = await one(sql, `select 1 from xodo_runs where id = $1 and status in ('waiting_takeover', 'running')`, [row.control_run_id]);
    if (kept) return row.control_run_id;
  }
  const waiting = await one<{ id: string }>(
    sql,
    `select id from xodo_runs where agency_id = $1 and status = 'waiting_takeover' order by heartbeat_at desc limit 1`,
    [row.agency_id],
  );
  if (waiting) return waiting.id;
  if (row.screen_run_id && time(row.screen_expires_at) > now.getTime()) {
    const screen = await one(sql, `select 1 from xodo_runs where id = $1 and status = 'running'`, [row.screen_run_id]);
    if (screen) return row.screen_run_id;
  }
  return null;
}

/**
 * Assume o controle: lease de 15 minutos, token novo (só o hash fica no banco), tokens gravados
 * na máquina e VNC de controle e PTY ligados. Um admin pode tomar de outra pessoa.
 */
export async function takeControl(deps: ControlDeps, agencyId: string, userId: string): Promise<ControlGrant> {
  const { sql } = deps;
  const role = await roleOf(sql, agencyId, userId);
  if (!role) throw new XodoError("Não encontrado", 404);
  if (!CAN_TAKE.includes(role)) throw new XodoError("Quem só assiste não pode assumir o computador.", 403);
  const before = await requireComputer(sql, agencyId);
  const holder = heldBy(before, nowOf(deps));
  if (holder && holder !== userId && !CAN_REVOKE.includes(role)) {
    throw new XodoError("Outra pessoa da equipe está no controle do computador agora.", 409);
  }

  // Liga a máquina antes de pegar o lease (pode levar alguns segundos na primeira vez).
  const machine = await ensureRunning(deps, agencyId);
  const row = await requireComputer(sql, agencyId);
  const now = nowOf(deps);
  const current = heldBy(row, now);
  if (current && current !== userId && !CAN_REVOKE.includes(role)) {
    throw new XodoError("Outra pessoa da equipe está no controle do computador agora.", 409);
  }
  const runId = await runToServe(sql, row, now);
  const token = newToken();
  const leaseId = randomUUID();
  const expiresMs = now.getTime() + CONTROL_LEASE_MS;
  const claimed = await one<ComputerRow>(
    sql,
    `update computers set control_user_id = $3, control_lease_id = $4, control_fence = control_fence + 1, control_token_hash = $5,
            control_started_at = $6::timestamptz, control_expires_at = $7::timestamptz, control_run_id = $8, updated_at = now()
      where id = $1 and control_fence = $2 returning *`,
    [row.id, row.control_fence, userId, leaseId, hashToken(token), now.toISOString(), iso(expiresMs), runId],
  );
  if (!claimed) throw new XodoError("O controle do computador mudou agora. Tente de novo.", 409);

  try {
    await rootRun(machine, startControlScript(token, expiresMs));
  } catch (error) {
    // Desfaz o lease (só se ainda for este) para os xodós não ficarem parados à toa.
    await sql.query(
      `update computers set control_user_id = null, control_lease_id = null, control_token_hash = null, control_started_at = null,
              control_expires_at = null, control_fence = control_fence + 1
        where id = $1 and control_lease_id = $2`,
      [row.id, leaseId],
    );
    await logEvent(sql, { agencyId, computerId: row.id, kind: "assumir_controle", status: "failed", summary: safeError(error), userId });
    throw new XodoError("Não consegui abrir o controle do computador. Tente de novo em instantes.", 502);
  }

  const revoked = current && current !== userId ? current : null;
  if (revoked) {
    await logEvent(sql, { agencyId, computerId: row.id, kind: "controle_revogado", summary: "um admin assumiu o computador", userId: revoked });
  }
  await logEvent(sql, { agencyId, computerId: row.id, kind: "assumir_controle", userId, runId });
  const base = await screenBase(machine);
  return {
    leaseId,
    expiresAt: iso(expiresMs),
    runId,
    viewUrl: pageUrl(base, "view.html", `c-${token}`),
    terminalUrl: pageUrl(base, "terminal.html", `t-${token}`),
    releaseToken: releaseToken(deps.masterKey, leaseId),
    revokedUserId: revoked,
  };
}

/** Renova o lease por mais 15 minutos, até 2 horas desde que a pessoa assumiu. */
export async function heartbeat(deps: ControlDeps, agencyId: string, userId: string, leaseId: string): Promise<{ expiresAt: string }> {
  const { sql } = deps;
  const row = await requireComputer(sql, agencyId);
  const now = nowOf(deps);
  if (row.control_lease_id !== leaseId || row.control_user_id !== userId) {
    throw new XodoError("Você não está mais no controle do computador.", 409);
  }
  if (time(row.control_expires_at) <= now.getTime()) throw new XodoError("O controle do computador venceu. Assuma de novo.", 410);
  const limit = time(row.control_started_at) + CONTROL_MAX_MS;
  if (limit <= now.getTime()) throw new XodoError("O controle chegou ao limite de 2 horas. Devolva e assuma de novo.", 410);
  const expiresMs = Math.min(now.getTime() + CONTROL_LEASE_MS, limit);
  const renewed = await one(
    sql,
    `update computers set control_expires_at = $4::timestamptz, updated_at = now()
      where id = $1 and control_lease_id = $2 and control_fence = $3 returning id`,
    [row.id, leaseId, row.control_fence, iso(expiresMs)],
  );
  if (!renewed) throw new XodoError("Você não está mais no controle do computador.", 409);
  // A pessoa ativa conta como atividade: adia a pausa por ociosidade e o vencimento na máquina.
  const machine = await ensureRunning(deps, agencyId);
  try {
    await rootRun(machine, extendControlScript(expiresMs));
  } catch (error) {
    await logEvent(sql, { agencyId, computerId: row.id, kind: "renovar_controle", status: "failed", summary: safeError(error), userId });
    throw new XodoError("Não consegui renovar o controle na máquina. Assuma de novo.", 502);
  }
  return { expiresAt: iso(expiresMs) };
}

export type ReleaseResult = { runId: string | null; resumed: RunStatus | null | "deferred" };

/** Retoma a execução que esperava a pessoa (na hora ou depois da resposta). */
async function resume(deps: ControlDeps, runId: string | null, reason: ControlReason): Promise<RunStatus | null | "deferred"> {
  if (!runId || !deps.engine) return null;
  const waiting = await one(deps.sql, `select 1 from xodo_runs where id = $1 and status = 'waiting_takeover'`, [runId]);
  if (!waiting) return null;
  const engine = deps.engine;
  const task = () => resumeTakeover(engine, runId, reason);
  if (deps.defer) {
    deps.defer(runId, task);
    return "deferred";
  }
  try {
    return await task();
  } catch (error) {
    console.error("[computador] retomada falhou", runId, safeError(error));
    return null;
  }
}

/** Encerra o lease (troca atômica pelo lease_id), derruba o controle na máquina e retoma a execução. */
async function endLease(
  deps: ControlDeps,
  row: ComputerRow,
  reason: ControlReason,
  actor: { userId: string | null; kind: string },
): Promise<ReleaseResult> {
  const { sql } = deps;
  const cleared = await one<{ id: string }>(
    sql,
    `update computers set control_user_id = null, control_lease_id = null, control_token_hash = null, control_started_at = null,
            control_expires_at = null, control_run_id = null, control_fence = control_fence + 1, updated_at = now()
      where id = $1 and control_lease_id = $2 returning id`,
    [row.id, row.control_lease_id],
  );
  if (!cleared) throw new XodoError("O controle do computador mudou agora. Tente de novo.", 409);
  // Na máquina só se ela está ligada; pausada, o vigia apaga o token vencido quando ela voltar.
  if (isLive(row, nowOf(deps))) {
    try {
      const machine = await ensureRunning(deps, row.agency_id);
      await rootRun(machine, stopControlScript());
    } catch (error) {
      await logEvent(sql, { agencyId: row.agency_id, computerId: row.id, kind: "derrubar_controle", status: "failed", summary: safeError(error) });
    }
  }
  const label = { done: "a pessoa terminou", skipped: "a pessoa não fez", expired: "o controle venceu" }[reason];
  await logEvent(sql, { agencyId: row.agency_id, computerId: row.id, kind: actor.kind, summary: label, userId: actor.userId, runId: row.control_run_id });
  return { runId: row.control_run_id, resumed: await resume(deps, row.control_run_id, reason) };
}

/**
 * Devolve o controle. A própria pessoa devolve o dela; owner e admin podem devolver o de outra.
 * Com leaseId, só devolve se ainda for aquele lease.
 */
export async function release(
  deps: ControlDeps,
  agencyId: string,
  userId: string,
  reason: "done" | "skipped",
  leaseId?: string,
): Promise<ReleaseResult> {
  const { sql } = deps;
  const row = await requireComputer(sql, agencyId);
  if (!row.control_lease_id || !row.control_user_id) throw new XodoError("Ninguém está no controle do computador.", 409);
  if (leaseId && row.control_lease_id !== leaseId) throw new XodoError("Você não está mais no controle do computador.", 409);
  if (row.control_user_id !== userId) {
    const role = await roleOf(sql, agencyId, userId);
    if (!role || !CAN_REVOKE.includes(role)) throw new XodoError("Só quem está no controle (ou um admin) pode devolver.", 403);
  }
  return endLease(deps, row, reason, { userId, kind: row.control_user_id === userId ? "devolver_controle" : "controle_revogado" });
}

/** Devolve pelo link de uso único (rota pública, para quem está no Slack ou no WhatsApp). */
export async function releaseByLink(deps: ControlDeps, token: string): Promise<ReleaseResult> {
  const invalid = new XodoError("Link inválido ou já usado.", 404);
  const leaseId = leaseFromReleaseToken(deps.masterKey, token);
  if (!leaseId) throw invalid;
  const row = await one<ComputerRow>(deps.sql, `select * from computers where control_lease_id = $1`, [leaseId]);
  if (!row) throw invalid;
  const loaded = await requireComputer(deps.sql, row.agency_id);
  if (loaded.control_lease_id !== leaseId) throw invalid;
  return endLease(deps, loaded, "done", { userId: loaded.control_user_id, kind: "devolver_controle" });
}

/**
 * Mensagem da pessoa no chat do app enquanto a execução espera por ela: vale como "done".
 * Se ela mesma está no controle, devolve; se ninguém está, só retoma; se outra pessoa está lá,
 * não faz nada (os xodós continuam parados até ela devolver). Devolve se tratou a mensagem.
 */
export async function takeoverDoneByMessage(deps: ControlDeps, runId: string, userId: string): Promise<boolean> {
  const { sql } = deps;
  const run = await one<{ agency_id: string; status: string }>(sql, `select agency_id, status from xodo_runs where id = $1`, [runId]);
  if (!run || run.status !== "waiting_takeover") return false;
  const row = await loadComputer(sql, run.agency_id);
  const holder = row ? heldBy(row, nowOf(deps)) : null;
  if (row && holder === userId) {
    const result = await endLease(deps, row, "done", { userId, kind: "devolver_controle" });
    // O lease era de outra execução: retoma esta também.
    if (result.runId !== runId) await resume(deps, runId, "done");
    return true;
  }
  if (holder) return false;
  await resume(deps, runId, "done");
  return true;
}

/** Cron: vence os leases passados do prazo e retoma as execuções com "expired". */
export async function expireControls(deps: ControlDeps, engine: EngineDeps | undefined = deps.engine): Promise<number> {
  const scoped: ControlDeps = { ...deps, engine };
  const rows = await deps.sql.query<ComputerRow>(
    `select * from computers where control_lease_id is not null and control_expires_at <= $1::timestamptz`,
    [nowOf(deps).toISOString()],
  );
  let expired = 0;
  for (const raw of rows) {
    const row = await loadComputer(deps.sql, raw.agency_id);
    if (!row?.control_lease_id || time(row.control_expires_at) > nowOf(deps).getTime()) continue;
    try {
      await endLease(scoped, row, "expired", { userId: row.control_user_id, kind: "controle_vencido" });
      expired += 1;
    } catch (error) {
      if (!(error instanceof XodoError)) throw error;
    }
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Tela ao vivo
// ---------------------------------------------------------------------------

export type ScreenUrls = {
  live: boolean;
  state: ComputerRow["state"];
  viewUrl: string | null;
  viewExpiresAt: string | null;
  /** Só para quem está no controle (token novo a cada pedido). */
  control: { leaseId: string; viewUrl: string; terminalUrl: string; expiresAt: string } | null;
};

/**
 * URL da tela para assistir (token de 15 minutos, só leitura). Para quem está no controle, também
 * as URLs de controle e terminal (com token novo; só o hash fica no banco). Com a máquina pausada
 * não liga nada: abrir a tela não gera custo.
 */
export async function screenUrls(deps: ControlDeps, agencyId: string, userId: string, role: Role): Promise<ScreenUrls> {
  const { sql } = deps;
  if (!(["owner", "admin", "member", "viewer"] as Role[]).includes(role)) throw new XodoError("Não encontrado", 404);
  const row = await requireComputer(sql, agencyId);
  const now = nowOf(deps);
  if (!isLive(row, now)) {
    const state = row.state === "running" ? "paused" : row.state;
    return { live: false, state, viewUrl: null, viewExpiresAt: null, control: null };
  }
  const machine = await ensureRunning(deps, agencyId);
  const base = await screenBase(machine);
  const viewToken = newToken();
  const viewExpires = now.getTime() + VIEW_TOKEN_MS;
  await rootRun(machine, viewTokenScript(randomBytes(8).toString("hex"), viewToken, viewExpires)).catch((error) => {
    throw new XodoError(`Não consegui abrir a tela agora (${safeError(error)}).`, 502);
  });

  let control: ScreenUrls["control"] = null;
  const fresh = await requireComputer(sql, agencyId);
  if (heldBy(fresh, now) === userId && fresh.control_lease_id) {
    const token = newToken();
    const expiresMs = time(fresh.control_expires_at);
    const rotated = await one(
      sql,
      `update computers set control_token_hash = $3, control_fence = control_fence + 1, updated_at = now()
        where id = $1 and control_lease_id = $2 and control_fence = $4 returning id`,
      [fresh.id, fresh.control_lease_id, hashToken(token), fresh.control_fence],
    );
    if (rotated) {
      await rootRun(machine, rotateControlScript(token, expiresMs)).catch((error) => {
        throw new XodoError(`Não consegui abrir o controle agora (${safeError(error)}).`, 502);
      });
      control = {
        leaseId: fresh.control_lease_id,
        viewUrl: pageUrl(base, "view.html", `c-${token}`),
        terminalUrl: pageUrl(base, "terminal.html", `t-${token}`),
        expiresAt: iso(expiresMs),
      };
    }
  }
  return { live: true, state: "running", viewUrl: pageUrl(base, "view.html", `v-${viewToken}`), viewExpiresAt: iso(viewExpires), control };
}

/** Pessoa no controle agora (para o estado e para pausar/destruir). */
export function controlHolder(row: ComputerRow, now: Date): string | null {
  return heldBy(row, now);
}

/** Encerra o controle de quem estiver lá (antes de destruir a máquina): a execução segue com "skipped". */
export async function forceRelease(deps: ControlDeps, agencyId: string, userId: string | null): Promise<ReleaseResult | null> {
  const row = await loadComputer(deps.sql, agencyId);
  if (!row?.control_lease_id) return null;
  return endLease(deps, row, "skipped", { userId, kind: "controle_revogado" });
}

/** Junta o computador ao motor (as rotas e o cron montam assim as dependências do controle). */
export function withEngine(computer: ComputerDeps, engine: EngineDeps, defer?: ControlDeps["defer"]): ControlDeps {
  const { sql: _sql, now: _now, ...rest } = computer;
  void _sql;
  void _now;
  return { ...computer, engine: { ...engine, computer: engine.computer ?? rest }, defer };
}
