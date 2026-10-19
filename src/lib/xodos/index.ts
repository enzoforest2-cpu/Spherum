import { computerDeps } from "../computer";
import { serverIntegrations } from "../integrations";
import { serverSql, type Sql } from "./db";
import { serverLlm } from "./llm";
import { loadCredentialSecret } from "./manage";
import type { EngineDeps } from "./runner";
import { masterKeyFromEnv } from "./vault";

export { decideAction, sweep } from "./actions";
export { refreshFx } from "./fx";
export { createCredential, createXodo, listCredentials, revokeCredential, updateXodo } from "./manage";
export { createRoutine, runDueRoutines } from "./routines";
export { continueRun, resumeRun, startRun, XodoError, type EngineDeps } from "./runner";

/** Dependências de produção: banco do Supabase, catálogo de modelos e as chaves da agência. */
export async function productionDeps(sql?: Sql): Promise<EngineDeps> {
  const db = sql ?? (await serverSql());
  const masterKey = masterKeyFromEnv();
  return {
    sql: db,
    llm: serverLlm(),
    secretFor: (agencyId, credentialId) => loadCredentialSecret(db, agencyId, credentialId, masterKey),
    integrations: serverIntegrations(),
    computer: engineComputer(db),
    chainSlice: sliceChainer(),
  };
}

/**
 * Próxima fatia de uma execução longa: chama a própria API (POST /api/xodos/runs/continue), que
 * responde na hora e continua em segundo plano numa função nova. Sem APP_URL ou CRON_SECRET, o
 * cron continua as fatias.
 */
function sliceChainer(): EngineDeps["chainSlice"] {
  const base = process.env.APP_URL?.trim();
  const secret = process.env.CRON_SECRET?.trim();
  if (!base || !secret) return undefined;
  return async (runId) => {
    const response = await fetch(new URL("/api/xodos/runs/continue", base), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`continuação respondeu ${response.status}`);
  };
}

/** O computador sem o banco e o relógio (o motor passa os dele). */
function engineComputer(db: Sql): EngineDeps["computer"] {
  const { sql: _sql, now: _now, ...rest } = computerDeps(db);
  void _sql;
  void _now;
  return rest;
}
