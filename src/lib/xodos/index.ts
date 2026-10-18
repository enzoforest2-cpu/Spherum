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
  };
}
