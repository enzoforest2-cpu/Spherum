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
 * As integrações (Gmail, Agenda, Drive, Telegram, WhatsApp) usam o mesmo cofre; appUrl é o
 * endereço local do app, para onde o login do Google volta (o servidor acerta depois de abrir).
 * Sem computador na nuvem.
 */
export function localDeps(sql: Sql, masterKey: string, appUrl = "http://127.0.0.1:4747"): EngineDeps {
  return {
    sql,
    llm: serverLlm(),
    secretFor: (ownerId, credentialId) => loadCredentialSecret(sql, ownerId, credentialId, masterKey),
    integrations: { masterKey, fetch: globalThis.fetch.bind(globalThis), appUrl },
  };
}
