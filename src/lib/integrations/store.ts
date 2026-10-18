import { randomUUID } from "node:crypto";
import { json, one, parseJson, type Sql } from "../xodos/db";
import { openSecret, sealSecret } from "../xodos/vault";
import { IntegrationError, type Fetch } from "./http";
import { OAUTH_PROVIDERS, oauthCreds, type TokenSet } from "./oauth-providers";

/**
 * Conexões das agências com apps e plataformas. Os segredos (tokens, chaves) ficam num
 * JSON cifrado com o mesmo cofre das chaves de IA, amarrado à agência e à conexão.
 */

export type ConnectionSecret = {
  accessToken?: string;
  refreshToken?: string | null;
  /** Para conexões por chave (Telegram, WhatsApp oficial manual, MCP, gateway do WhatsApp QR). */
  apiKey?: string;
  extra?: Record<string, unknown>;
};

export type ConnectionRow = {
  id: string;
  agency_id: string;
  provider: string;
  label: string;
  external_account: string | null;
  scopes: string[];
  status: "active" | "error" | "expired" | "revoked";
  ciphertext: string;
  token_expires_at: Date | string | null;
  metadata: Record<string, unknown>;
};

export type IntegrationDeps = { sql: Sql; masterKey: string; fetch: Fetch; appUrl: string; now?: () => Date };

const aad = (agencyId: string, id: string) => `integration_connections:${agencyId}:${id}`;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export type SaveInput = {
  agencyId: string;
  provider: string;
  label: string;
  account: string | null;
  scopes?: string[];
  secret: ConnectionSecret;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
};

/** Grava a conexão; se a mesma conta já estava conectada, atualiza os tokens e soma as permissões. */
export async function saveConnection(deps: IntegrationDeps, input: SaveInput): Promise<string> {
  const { sql, masterKey } = deps;
  const existing = input.account
    ? await one<{ id: string; scopes: string[] }>(
        sql,
        `select id, scopes from integration_connections
          where agency_id = $1 and provider = $2 and external_account = $3 and status <> 'revoked'`,
        [input.agencyId, input.provider, input.account],
      )
    : null;
  const id = existing?.id ?? randomUUID();
  const scopes = [...new Set([...(existing?.scopes ?? []), ...(input.scopes ?? [])])];
  const ciphertext = await sealSecret(JSON.stringify(input.secret), aad(input.agencyId, id), masterKey);
  if (existing) {
    await sql.query(
      `update integration_connections
          set label = $2, scopes = $3, status = 'active', ciphertext = $4, token_expires_at = $5::timestamptz,
              metadata = metadata || $6::jsonb, last_error = null, updated_at = now()
        where id = $1`,
      [id, input.label, scopes, ciphertext, input.expiresAt?.toISOString() ?? null, json(input.metadata ?? {})],
    );
  } else {
    await sql.query(
      `insert into integration_connections
         (id, agency_id, provider, label, external_account, scopes, ciphertext, token_expires_at, metadata, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10)`,
      [id, input.agencyId, input.provider, input.label, input.account, scopes, ciphertext,
        input.expiresAt?.toISOString() ?? null, json(input.metadata ?? {}), input.createdBy ?? null],
    );
  }
  return id;
}

export async function loadConnection(sql: Sql, agencyId: string, connectionId: string): Promise<ConnectionRow> {
  const row = await one<ConnectionRow>(sql, `select * from integration_connections where id = $1 and agency_id = $2`, [
    connectionId,
    agencyId,
  ]);
  if (!row) throw new IntegrationError("Conexão não encontrada.", 404);
  return { ...row, metadata: parseJson(row.metadata) ?? {} };
}

export async function readSecret(deps: IntegrationDeps, row: ConnectionRow): Promise<ConnectionSecret> {
  return JSON.parse(await openSecret(row.ciphertext, aad(row.agency_id, row.id), deps.masterKey)) as ConnectionSecret;
}

export type Access = { connection: ConnectionRow; secret: ConnectionSecret; accessToken: string };

/**
 * Token válido de uma conexão. Renova antes de vencer, com a linha travada para que duas
 * chamadas ao mesmo tempo não renovem juntas (alguns provedores trocam o refresh token a cada uso).
 */
export async function access(deps: IntegrationDeps, agencyId: string, connectionId: string): Promise<Access> {
  const now = deps.now ? deps.now() : new Date();
  const row = await loadConnection(deps.sql, agencyId, connectionId);
  if (row.status === "revoked") throw new IntegrationError(`A conexão ${row.label} foi desconectada.`, 409, true);
  if (row.status === "expired") throw new IntegrationError(`O login de ${row.label} venceu. Reconecte em Integrações.`, 409, true);
  const secret = await readSecret(deps, row);
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at) : null;
  const fresh = !expiresAt || expiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
  if (fresh || !secret.refreshToken) {
    const token = secret.accessToken ?? secret.apiKey;
    if (!token) throw new IntegrationError(`A conexão ${row.label} não tem token.`, 409, true);
    return { connection: row, secret, accessToken: token };
  }

  const provider = OAUTH_PROVIDERS[row.provider];
  if (!provider?.refresh) return { connection: row, secret, accessToken: secret.accessToken! };
  let failure: { error: unknown; reauth: boolean } | null = null;
  const refreshed = await deps.sql.transaction(async (tx): Promise<Access | null> => {
    // Outra chamada pode ter renovado enquanto esperávamos a trava.
    const locked = await one<ConnectionRow>(tx, `select * from integration_connections where id = $1 for update`, [row.id]);
    const current = await readSecret(deps, locked!);
    const lockedExpiry = locked!.token_expires_at ? new Date(locked!.token_expires_at) : null;
    if (lockedExpiry && lockedExpiry.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
      return { connection: { ...row, ...locked!, metadata: row.metadata }, secret: current, accessToken: current.accessToken! };
    }
    let tokens: TokenSet;
    try {
      tokens = await provider.refresh!(current.refreshToken!, oauthCreds(provider, deps.appUrl), deps.fetch);
    } catch (error) {
      failure = { error, reauth: error instanceof IntegrationError && error.reauth };
      return null;
    }
    const next: ConnectionSecret = { ...current, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? current.refreshToken };
    const expires = tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null;
    await tx.query(
      `update integration_connections set ciphertext = $2, token_expires_at = $3::timestamptz, status = 'active',
              last_error = null, updated_at = now() where id = $1`,
      [row.id, await sealSecret(JSON.stringify(next), aad(row.agency_id, row.id), deps.masterKey), expires?.toISOString() ?? null],
    );
    return { connection: row, secret: next, accessToken: tokens.accessToken };
  });
  if (refreshed) return refreshed;
  // A marcação fica fora da transação: se ela fosse desfeita junto, a conexão continuaria "ativa".
  const { error, reauth } = failure!;
  await deps.sql.query(`update integration_connections set status = $2, last_error = $3, updated_at = now() where id = $1`, [
    row.id,
    reauth ? "expired" : "error",
    String(error instanceof Error ? error.message : error).slice(0, 500),
  ]);
  if (reauth) throw new IntegrationError(`O login de ${row.label} venceu. Reconecte em Integrações.`, 409, true);
  throw error;
}

export async function listConnections(sql: Sql, agencyId: string) {
  return sql.query(
    `select id, provider, label, external_account, scopes, status, token_expires_at::text, metadata, last_error,
            created_at::text, updated_at::text
       from integration_connections where agency_id = $1 and status <> 'revoked' order by created_at desc`,
    [agencyId],
  );
}

/** Desconecta: tenta revogar no provedor e apaga os tokens guardados. */
export async function revokeConnection(deps: IntegrationDeps, agencyId: string, connectionId: string) {
  const row = await loadConnection(deps.sql, agencyId, connectionId);
  if (row.status === "revoked") return;
  const provider = OAUTH_PROVIDERS[row.provider];
  if (provider?.revoke) {
    try {
      const secret = await readSecret(deps, row);
      await provider.revoke({ accessToken: secret.accessToken ?? "", refreshToken: secret.refreshToken }, oauthCreds(provider, deps.appUrl), deps.fetch);
    } catch (error) {
      // A revogação no provedor é cortesia; o importante é apagar os tokens daqui.
      console.warn("[integrações] falha ao revogar no provedor", row.provider, error instanceof Error ? error.message : error);
    }
  }
  await deps.sql.query(
    `update integration_connections set status = 'revoked', ciphertext = $2, updated_at = now() where id = $1`,
    [row.id, await sealSecret("{}", aad(row.agency_id, row.id), deps.masterKey)],
  );
}

/**
 * A Meta não renova o token sozinha (dura cerca de 60 dias). Uma semana antes de vencer,
 * avisa a agência uma vez para reconectar.
 */
export async function warnExpiringConnections(deps: IntegrationDeps) {
  const now = deps.now ? deps.now() : new Date();
  const rows = await deps.sql.query<{ id: string; agency_id: string; label: string; token_expires_at: Date | string }>(
    `update integration_connections
        set metadata = metadata || jsonb_build_object('expiry_warned_at', $1::text)
      where provider = 'meta' and status = 'active' and token_expires_at is not null
        and token_expires_at between $1::timestamptz and $2::timestamptz
        and not (metadata ? 'expiry_warned_at')
      returning id, agency_id, label, token_expires_at`,
    [now.toISOString(), new Date(now.getTime() + 7 * 86_400_000).toISOString()],
  );
  for (const row of rows) {
    const days = Math.max(1, Math.round((new Date(row.token_expires_at).getTime() - now.getTime()) / 86_400_000));
    await deps.sql.query(
      `insert into notifications (agency_id, kind, title, body, data) values ($1, 'integration_expiring', $2, $3, $4::jsonb)`,
      [row.agency_id, `O login da Meta (${row.label}) vence em ${days} dia${days > 1 ? "s" : ""}`,
        "Reconecte em Integrações para os xodós continuarem lendo e mexendo nos anúncios.", JSON.stringify({ connection_id: row.id })],
    );
  }
  return rows.length;
}
