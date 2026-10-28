import type { Sql } from "./db";
import { serverLlm } from "./llm";
import { loadCredentialSecret } from "./manage";
import type { EngineDeps } from "./runner";

export { decideAction, sweep } from "./actions";
export { refreshFx } from "./fx";
export { createCredential, createXodo, listCredentials, revokeCredential, updateXodo } from "./manage";
export { createRoutine, runDueRoutines } from "./routines";
export { continueRun, resumeRun, startRun, XodoError, type EngineDeps } from "./runner";

/**
 * Dependências do motor no app pessoal: o banco embutido, o catálogo de modelos e as suas
 * chaves de IA, cifradas com a chave mestra guardada na pasta de dados do app.
 * Sem computador na nuvem e, por enquanto, sem integrações (Gmail e Agenda vêm depois).
 */
export function localDeps(sql: Sql, masterKey: string): EngineDeps {
  return {
    sql,
    llm: serverLlm(),
    secretFor: (ownerId, credentialId) => loadCredentialSecret(sql, ownerId, credentialId, masterKey),
  };
}
