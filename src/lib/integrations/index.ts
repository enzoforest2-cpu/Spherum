import { masterKeyFromEnv } from "../xodos/vault";
import type { IntegrationDeps } from "./store";

/** Dependências de produção das integrações (o banco entra por quem chama). */
export function serverIntegrations(): Omit<IntegrationDeps, "sql" | "now"> {
  return {
    masterKey: masterKeyFromEnv(),
    fetch: globalThis.fetch.bind(globalThis),
    appUrl: process.env.APP_URL || "https://spherum.com.br",
  };
}
