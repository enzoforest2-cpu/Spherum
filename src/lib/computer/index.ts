import type { Sql } from "../xodos/db";
import { masterKeyFromEnv } from "../xodos/vault";
import type { ComputerDeps } from "./lifecycle";
import type { ProviderId } from "./provider";
import { daytonaProvider } from "./providers/daytona";
import { e2bProvider } from "./providers/e2b";
import { storageFromEnv } from "./storage";

/**
 * Dependências de produção do computador: E2B e Daytona com a chave de cada agência (BYOK), a
 * chave do Spherum só se estiver configurada (add-on) e o bucket privado de arquivos.
 */
export function computerDeps(sql: Sql, env: Record<string, string | undefined> = process.env): ComputerDeps {
  const spherumKeys: Partial<Record<ProviderId, string>> = {};
  const e2b = env.SPHERUM_E2B_API_KEY?.trim();
  const daytona = env.SPHERUM_DAYTONA_API_KEY?.trim();
  if (e2b) spherumKeys.e2b = e2b;
  if (daytona) spherumKeys.daytona = daytona;
  return {
    sql,
    masterKey: masterKeyFromEnv(),
    providers: { e2b: e2bProvider(), daytona: daytonaProvider() },
    spherumKeys,
    storage: storageFromEnv(env) ?? undefined,
  };
}
