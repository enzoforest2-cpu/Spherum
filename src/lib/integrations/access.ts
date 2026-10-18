import { one, type Sql } from "../xodos/db";
import type { Xodo } from "../xodos/types";
import { APPS, missingScopes, type AppId } from "./apps";
import { IntegrationError, type Fetch } from "./http";
import { access, type Access, type IntegrationDeps } from "./store";

/**
 * Como uma ferramenta de app chega à conexão certa: o app precisa estar liberado para o
 * xodó ("Pode mexer em") e a agência precisa ter uma conexão ativa daquele provedor com as
 * permissões do app. Se o xodó fixou uma conexão, usa ela; senão, a mais recente.
 */

export type AppAccess = {
  use(app: AppId): Promise<Access & { http: Fetch }>;
  /** Usa uma conexão específica (ex.: a que foi usada para ligar a conta de anúncio), se o app estiver liberado. */
  useConnection(app: AppId, connectionId: string): Promise<Access & { http: Fetch }>;
  http: Fetch;
  /** Dependências por trás do acesso (para sincronizações que gravam no banco). */
  deps: IntegrationDeps;
};

export async function xodoApps(sql: Sql, xodo: Pick<Xodo, "id" | "agency_id">) {
  return sql.query<{ app: AppId; connection_id: string | null }>(
    `select app, connection_id from xodo_apps where xodo_id = $1 and agency_id = $2`,
    [xodo.id, xodo.agency_id],
  );
}

export async function connectionFor(sql: Sql, xodo: Pick<Xodo, "id" | "agency_id">, app: AppId): Promise<string> {
  const granted = await one<{ connection_id: string | null }>(
    sql,
    `select connection_id from xodo_apps where xodo_id = $1 and agency_id = $2 and app = $3`,
    [xodo.id, xodo.agency_id, app],
  );
  if (!granted) throw new IntegrationError(`${APPS[app].label} não está liberado para este xodó.`, 403);
  if (granted.connection_id) return granted.connection_id;
  const rows = await sql.query<{ id: string; scopes: string[] }>(
    `select id, scopes from integration_connections
      where agency_id = $1 and provider = any($2::text[]) and status = 'active'
      order by updated_at desc`,
    [xodo.agency_id, APPS[app].providers],
  );
  const ok = rows.find((r) => missingScopes(app, r.scopes).length === 0);
  if (ok) return ok.id;
  if (rows.length) throw new IntegrationError(`Reconecte ${APPS[app].label} dando a permissão que falta.`, 409, true);
  throw new IntegrationError(`A agência ainda não conectou ${APPS[app].label}. Conecte em Integrações.`, 409);
}

export function appAccess(deps: IntegrationDeps, xodo: Pick<Xodo, "id" | "agency_id">): AppAccess {
  return {
    http: deps.fetch,
    deps,
    async use(app) {
      const connectionId = await connectionFor(deps.sql, xodo, app);
      const result = await access(deps, xodo.agency_id, connectionId);
      const missing = missingScopes(app, result.connection.scopes);
      if (missing.length) throw new IntegrationError(`Reconecte ${APPS[app].label} dando a permissão que falta.`, 409, true);
      return { ...result, http: deps.fetch };
    },
    async useConnection(app, connectionId) {
      await assertAppAllowed(deps.sql, xodo, app);
      const result = await access(deps, xodo.agency_id, connectionId);
      if (!APPS[app].providers.includes(result.connection.provider as never)) {
        throw new IntegrationError(`A conexão não é de ${APPS[app].label}.`, 409);
      }
      return { ...result, http: deps.fetch };
    },
  };
}

async function assertAppAllowed(sql: Sql, xodo: Pick<Xodo, "id" | "agency_id">, app: AppId) {
  const ok = await one(sql, `select 1 from xodo_apps where xodo_id = $1 and agency_id = $2 and app = $3`, [xodo.id, xodo.agency_id, app]);
  if (!ok) throw new IntegrationError(`${APPS[app].label} não está liberado para este xodó.`, 403);
}
