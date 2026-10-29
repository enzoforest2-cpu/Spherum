import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { APPS, type AppId } from "../src/integrations/apps";
import { IntegrationError } from "../src/integrations/http";
import { OAUTH_PROVIDERS, oauthCreds } from "../src/integrations/oauth-providers";
import { listConnections, revokeConnection, saveConnection, type IntegrationDeps } from "../src/integrations/store";
import { one } from "../src/xodos/db";
import { XodoError } from "../src/xodos/errors";
import { openSecret, sealSecret } from "../src/xodos/vault";

/**
 * Login com o Google (Gmail, Agenda e Drive) no app pessoal.
 *
 * No Spherum o "app do Google" (client id e secret) é do próprio Spherum, nas variáveis de
 * ambiente. Aqui cada pessoa cria o seu no Google Cloud (tipo "App para computador", que aceita
 * voltar para 127.0.0.1) e cola na tela. Ele fica cifrado na pasta de dados e, ao abrir,
 * vira GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET para o motor usar como no Spherum.
 */

const GOOGLE_FILE = "google-oauth.json";
const GOOGLE_AAD = "local:google-oauth";
const STATE_TTL_MS = 10 * 60 * 1000;

/** Apps do Google que o app pessoal oferece (Ads e Analytics ficam para o Spherum). */
export const GOOGLE_APPS = ["gmail", "calendar", "drive"] as const satisfies readonly AppId[];

export const googleClientInput = z.object({
  client_id: z.string().trim().min(10).max(300).regex(/\.apps\.googleusercontent\.com$/, "o ID do cliente termina em .apps.googleusercontent.com"),
  client_secret: z.string().trim().min(6).max(300),
});

export async function loadGoogleClient(dataDir: string, masterKey: string): Promise<void> {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) return;
  const file = path.join(dataDir, GOOGLE_FILE);
  if (!existsSync(file)) return;
  try {
    const sealed = JSON.parse(readFileSync(file, "utf8")) as { client_id: string; secret: string };
    process.env.GOOGLE_CLIENT_ID = sealed.client_id;
    process.env.GOOGLE_CLIENT_SECRET = await openSecret(sealed.secret, GOOGLE_AAD, masterKey);
  } catch (error) {
    console.warn("[google] não consegui ler o app do Google salvo", error instanceof Error ? error.message : error);
  }
}

export async function saveGoogleClient(dataDir: string, masterKey: string, body: unknown) {
  const input = googleClientInput.parse(body);
  const secret = await sealSecret(input.client_secret, GOOGLE_AAD, masterKey);
  writeFileSync(path.join(dataDir, GOOGLE_FILE), JSON.stringify({ client_id: input.client_id, secret }, null, 2) + "\n", { mode: 0o600 });
  process.env.GOOGLE_CLIENT_ID = input.client_id;
  process.env.GOOGLE_CLIENT_SECRET = input.client_secret;
}

export const googleConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const connectInput = z.object({ apps: z.array(z.enum(GOOGLE_APPS)).min(1).max(GOOGLE_APPS.length) });

/** Começa o login: grava o state (uso único, 10 min) e devolve o endereço do Google. */
export async function startGoogleLogin(deps: IntegrationDeps, agencyId: string, userId: string, body: unknown): Promise<string> {
  if (!googleConfigured()) throw new XodoError("Cadastre primeiro o app do Google (ID e chave secreta do cliente).", 409);
  const { apps } = connectInput.parse(body);
  const provider = OAUTH_PROVIDERS.google;
  const creds = oauthCreds(provider, deps.appUrl);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const now = deps.now ? deps.now() : new Date();
  await deps.sql.query(
    `insert into oauth_states (state, agency_id, user_id, provider, apps, code_verifier, expires_at) values ($1, $2, $3, 'google', $4, $5, $6::timestamptz)`,
    [state, agencyId, userId, apps, verifier, new Date(now.getTime() + STATE_TTL_MS).toISOString()],
  );
  const scopes = [...new Set(apps.flatMap((a) => APPS[a].scopes))];
  return provider.authorizeUrl({ clientId: creds.clientId, redirectUri: creds.redirectUri, state, scopes, codeChallenge: challenge });
}

/** Volta do Google: troca o código por tokens e guarda a conta. Devolve o rótulo da conta. */
export async function finishGoogleLogin(deps: IntegrationDeps, query: URLSearchParams): Promise<string> {
  if (query.get("error")) throw new IntegrationError(query.get("error") === "access_denied" ? "Você cancelou o login no Google." : `O Google recusou: ${query.get("error")}`, 400);
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  const now = deps.now ? deps.now() : new Date();
  const row = await one<{ agency_id: string; user_id: string; code_verifier: string | null }>(
    deps.sql,
    `update oauth_states set used_at = $2::timestamptz
      where state = $1 and provider = 'google' and used_at is null and expires_at > $2::timestamptz
      returning agency_id, user_id, code_verifier`,
    [state, now.toISOString()],
  );
  if (!row || !code) throw new IntegrationError("Esse login venceu ou já foi usado. Tente conectar de novo pelo app.", 400);
  const provider = OAUTH_PROVIDERS.google;
  const tokens = await provider.exchange(code, oauthCreds(provider, deps.appUrl), deps.fetch, row.code_verifier ?? undefined);
  const who = await provider.identity(tokens, deps.fetch);
  await saveConnection(deps, {
    agencyId: row.agency_id,
    provider: "google",
    label: who.label,
    account: who.account,
    scopes: tokens.scopes,
    secret: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    expiresAt: tokens.expiresIn ? new Date(now.getTime() + tokens.expiresIn * 1000) : null,
    createdBy: row.user_id,
  });
  return who.label;
}

/** Contas conectadas (Google e canais), sem segredo nenhum. */
export async function connections(deps: IntegrationDeps, agencyId: string) {
  const rows = (await listConnections(deps.sql, agencyId)) as { provider: string; scopes: string[] }[];
  return rows.map((r) => ({
    ...r,
    // Quais apps do Google essa conta já liberou (o login pode ter pedido só parte).
    apps: r.provider === "google" ? GOOGLE_APPS.filter((a) => APPS[a].scopes.every((s) => (r.scopes as string[]).includes(s))) : [],
  }));
}

export async function disconnect(deps: IntegrationDeps, agencyId: string, connectionId: string) {
  await revokeConnection(deps, agencyId, connectionId);
  await deps.sql.query(`delete from xodo_apps where agency_id = $1 and connection_id = $2`, [agencyId, connectionId]);
}

/** Página simples que o navegador mostra ao voltar do Google. */
export function callbackPage(ok: boolean, message: string): string {
  const esc = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Xodós</title>
<style>body{font:16px/1.5 "Segoe UI",system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f8fa;color:#101828}
main{max-width:420px;padding:32px;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgba(16,24,40,.08);text-align:center}
h1{font-size:22px;margin:0 0 8px;color:${ok ? "#465fff" : "#d92d20"}}a{color:#465fff}
@media (prefers-color-scheme: dark){body{background:#0f1117;color:#f2f4f7}main{background:#181b23}}</style></head>
<body><main><h1>${ok ? "Conectado!" : "Não deu certo"}</h1><p>${esc}</p><p><a href="/#/integracoes">Voltar aos Xodós</a></p></main></body></html>`;
}
