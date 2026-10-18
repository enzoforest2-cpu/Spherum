import { createHash, randomBytes } from "node:crypto";
import { one } from "../xodos/db";
import { APPS, type AppId } from "./apps";
import { IntegrationError } from "./http";
import { OAUTH_PROVIDERS, oauthCreds } from "./oauth-providers";
import { saveConnection, type IntegrationDeps } from "./store";

/**
 * Login OAuth: o navegador pede a URL (com o token do Supabase), vai até a plataforma e
 * volta no callback. O state é de uso único, vence em 10 minutos e amarra o retorno à
 * agência e à pessoa que pediu. PKCE onde a plataforma aceita.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const b64url = (buf: Buffer) => buf.toString("base64url");

export type StartInput = { agencyId: string; userId: string; provider: string; apps: AppId[]; returnTo?: string };

export async function startOAuth(deps: IntegrationDeps, input: StartInput): Promise<string> {
  const provider = OAUTH_PROVIDERS[input.provider];
  if (!provider) throw new IntegrationError(`Login por OAuth não existe para ${input.provider}.`, 400);
  for (const app of input.apps) {
    if (!APPS[app].providers.includes(input.provider as never)) {
      throw new IntegrationError(`${APPS[app].label} não usa o login de ${provider.label}.`, 400);
    }
  }
  const creds = oauthCreds(provider, deps.appUrl);
  const state = b64url(randomBytes(32));
  const verifier = provider.pkce ? b64url(randomBytes(48)) : null;
  const challenge = verifier ? b64url(createHash("sha256").update(verifier).digest()) : undefined;
  const now = deps.now ? deps.now() : new Date();
  // Só caminhos internos no retorno, para o callback não virar redirecionamento aberto.
  const returnTo = input.returnTo?.startsWith("/") && !input.returnTo.startsWith("//") ? input.returnTo : "/agencia";
  await deps.sql.query(
    `insert into oauth_states (state, agency_id, user_id, provider, apps, code_verifier, return_to, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [state, input.agencyId, input.userId, provider.id, input.apps, verifier, returnTo, new Date(now.getTime() + STATE_TTL_MS).toISOString()],
  );
  const scopes = [...new Set(input.apps.flatMap((app) => APPS[app].scopes))];
  return provider.authorizeUrl({ clientId: creds.clientId, redirectUri: creds.redirectUri, state, scopes, codeChallenge: challenge });
}

export type FinishInput = { provider: string; code?: string | null; state?: string | null; error?: string | null };

export async function finishOAuth(deps: IntegrationDeps, input: FinishInput) {
  const now = deps.now ? deps.now() : new Date();
  if (!input.state) throw new IntegrationError("Retorno do login sem state.", 400);
  // Consome o state numa troca atômica: um mesmo retorno não vale duas vezes.
  const st = await one<{ agency_id: string; user_id: string; provider: string; apps: string[]; code_verifier: string | null; return_to: string }>(
    deps.sql,
    `update oauth_states set used_at = $3::timestamptz
      where state = $1 and provider = $2 and used_at is null and expires_at > $3::timestamptz
      returning agency_id, user_id, provider, apps, code_verifier, return_to`,
    [input.state, input.provider, now.toISOString()],
  );
  if (!st) throw new IntegrationError("Este login venceu ou já foi usado. Tente conectar de novo.", 400);
  if (input.error) throw new IntegrationError(`A plataforma recusou a conexão: ${input.error}`, 400);
  if (!input.code) throw new IntegrationError("Retorno do login sem código.", 400);

  const provider = OAUTH_PROVIDERS[st.provider];
  const creds = oauthCreds(provider, deps.appUrl);
  const tokens = await provider.exchange(input.code, creds, deps.fetch, st.code_verifier ?? undefined);
  const who = await provider.identity(tokens, deps.fetch);
  const connectionId = await saveConnection(deps, {
    agencyId: st.agency_id,
    provider: provider.id,
    label: who.label,
    account: who.account,
    scopes: tokens.scopes,
    secret: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? null, extra: tokens.extra },
    expiresAt: tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null,
    metadata: who.metadata,
    createdBy: st.user_id,
  });
  return { agencyId: st.agency_id, connectionId, apps: st.apps as AppId[], returnTo: st.return_to };
}
