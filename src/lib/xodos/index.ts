import { serverSql, type Sql } from "./db";
import { loadApiKey } from "./manage";
import { createDriver } from "./providers";
import type { EngineDeps } from "./runner";
import { masterKeyFromEnv } from "./vault";

export { decideAction, sweep } from "./actions";
export { createCredential, createXodo, listCredentials, revokeCredential, updateXodo } from "./manage";
export { createRoutine, runDueRoutines } from "./routines";
export { continueRun, resumeRun, startRun, XodoError, type EngineDeps } from "./runner";

/** Dependências de produção: banco do Supabase e o modelo de verdade, com a chave da agência. */
export async function productionDeps(sql?: Sql): Promise<EngineDeps> {
  const db = sql ?? (await serverSql());
  const masterKey = masterKeyFromEnv();
  return {
    sql: db,
    driverFor: async (xodo) => createDriver(xodo.provider, xodo.model, await loadApiKey(db, xodo, masterKey)),
  };
}
