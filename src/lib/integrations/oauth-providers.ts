import { IntegrationError, requestJson, type Fetch } from "./http";

/**
 * Login OAuth de cada plataforma, com o app do próprio Spherum (client id e secret nas
 * variáveis de ambiente). Cada provedor sabe montar a URL de autorização, trocar o código
 * por tokens, renovar, descobrir quem conectou e revogar.
 */

export type TokenSet = {
  accessToken: string;
  refreshToken?: string | null;
  /** Validade em segundos a partir de agora; quem grava calcula a data com o relógio do motor. */
  expiresIn?: number | null;
  scopes?: string[];
  /** Dados extras não secretos que vêm com o token (ex.: contas de anúncio do TikTok). */
  extra?: Record<string, unknown>;
};

export type Identity = { account: string; label: string; metadata?: Record<string, unknown> };

export type ClientCreds = { clientId: string; clientSecret: string; redirectUri: string };

export type OAuthProvider = {
  id: string;
  label: string;
  env: { clientId: string; clientSecret: string };
  /** Usa PKCE (S256) no login. */
  pkce: boolean;
  authorizeUrl(p: { clientId: string; redirectUri: string; state: string; scopes: string[]; codeChallenge?: string }): string;
  exchange(code: string, creds: ClientCreds, http: Fetch, codeVerifier?: string): Promise<TokenSet>;
  refresh?(refreshToken: string, creds: ClientCreds, http: Fetch): Promise<TokenSet>;
  identity(tokens: TokenSet, http: Fetch): Promise<Identity>;
  revoke?(tokens: TokenSet, creds: ClientCreds, http: Fetch): Promise<void>;
};

const seconds = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const split = (value: unknown, sep: RegExp): string[] =>
  typeof value === "string" && value ? value.split(sep).map((s) => s.trim()).filter(Boolean) : [];

function url(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Google (Gmail, Agenda, Drive, Google Ads, GA4)
// ---------------------------------------------------------------------------

const google: OAuthProvider = {
  id: "google",
  label: "Google",
  env: { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET" },
  pkce: true,
  authorizeUrl: ({ clientId, redirectUri, state, scopes, codeChallenge }) =>
    url("https://accounts.google.com/o/oauth2/v2/auth", {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: ["openid", "email", "profile", ...scopes].join(" "),
      state,
      // offline + consent garantem o refresh token; include_granted_scopes soma às permissões já dadas.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge: codeChallenge,
      code_challenge_method: codeChallenge ? "S256" : undefined,
    }),
  async exchange(code, creds, http, codeVerifier) {
    const t = await requestJson<Record<string, unknown>>(http, "https://oauth2.googleapis.com/token", {
      method: "POST",
      form: {
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: creds.redirectUri,
        grant_type: "authorization_code",
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      },
    });
    return {
      accessToken: String(t.access_token),
      refreshToken: (t.refresh_token as string) ?? null,
      expiresIn: seconds(t.expires_in),
      scopes: split(t.scope, /\s+/),
    };
  },
  async refresh(refreshToken, creds, http) {
    const t = await requestJson<Record<string, unknown>>(http, "https://oauth2.googleapis.com/token", {
      method: "POST",
      form: { refresh_token: refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "refresh_token" },
    });
    return {
      accessToken: String(t.access_token),
      refreshToken: (t.refresh_token as string) ?? refreshToken,
      expiresIn: seconds(t.expires_in),
      scopes: split(t.scope, /\s+/),
    };
  },
  async identity(tokens, http) {
    const me = await requestJson<{ email?: string; name?: string }>(http, "https://openidconnect.googleapis.com/v1/userinfo", {
      bearer: tokens.accessToken,
    });
    const account = me.email ?? "conta-google";
    return { account, label: me.name ? `${me.name} (${account})` : account };
  },
  async revoke(tokens, _creds, http) {
    await requestJson(http, "https://oauth2.googleapis.com/revoke", {
      method: "POST",
      form: { token: tokens.refreshToken ?? tokens.accessToken },
    });
  },
};

// ---------------------------------------------------------------------------
// Meta (Meta Ads e WhatsApp oficial)
// ---------------------------------------------------------------------------

export const metaGraph = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v23.0"}`;

const meta: OAuthProvider = {
  id: "meta",
  label: "Meta",
  env: { clientId: "META_APP_ID", clientSecret: "META_APP_SECRET" },
  pkce: false,
  authorizeUrl: ({ clientId, redirectUri, state, scopes }) =>
    url(`https://www.facebook.com/${process.env.META_GRAPH_VERSION || "v23.0"}/dialog/oauth`, {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: scopes.join(","),
      response_type: "code",
    }),
  async exchange(code, creds, http) {
    const short = await requestJson<{ access_token: string }>(
      http,
      url(`${metaGraph()}/oauth/access_token`, {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: creds.redirectUri,
        code,
      }),
    );
    // Troca o token curto (horas) por um de longa duração (cerca de 60 dias). A Meta não dá refresh token:
    // perto de vencer, a agência reconecta (o cron avisa).
    const long = await requestJson<{ access_token: string; expires_in?: number }>(
      http,
      url(`${metaGraph()}/oauth/access_token`, {
        grant_type: "fb_exchange_token",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        fb_exchange_token: short.access_token,
      }),
    );
    const perms = await requestJson<{ data?: { permission: string; status: string }[] }>(http, `${metaGraph()}/me/permissions`, {
      bearer: long.access_token,
    });
    return {
      accessToken: long.access_token,
      expiresIn: seconds(long.expires_in ?? 60 * 24 * 3600),
      scopes: (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission),
    };
  },
  async identity(tokens, http) {
    const me = await requestJson<{ id: string; name?: string }>(http, `${metaGraph()}/me?fields=id,name`, { bearer: tokens.accessToken });
    return { account: me.id, label: me.name ?? `Meta ${me.id}` };
  },
  async revoke(tokens, _creds, http) {
    await requestJson(http, `${metaGraph()}/me/permissions`, { method: "DELETE", bearer: tokens.accessToken });
  },
};

// ---------------------------------------------------------------------------
// TikTok Ads (Business API)
// ---------------------------------------------------------------------------

export const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";

/** A API do TikTok responde 200 com { code, message, data }; code diferente de 0 é erro. */
export async function tiktokJson<T>(http: Fetch, path: string, init: Parameters<typeof requestJson>[2] = {}): Promise<T> {
  const r = await requestJson<{ code: number; message?: string; data?: T }>(http, `${TIKTOK_API}${path}`, init);
  if (r.code !== 0) {
    throw new IntegrationError(r.message ?? `TikTok respondeu código ${r.code}`, 502, r.code === 40001 || r.code === 40105);
  }
  return r.data as T;
}

const tiktok: OAuthProvider = {
  id: "tiktok",
  label: "TikTok",
  env: { clientId: "TIKTOK_APP_ID", clientSecret: "TIKTOK_APP_SECRET" },
  pkce: false,
  authorizeUrl: ({ clientId, redirectUri, state }) =>
    url("https://business-api.tiktok.com/portal/auth", { app_id: clientId, redirect_uri: redirectUri, state }),
  async exchange(code, creds, http) {
    const d = await tiktokJson<{ access_token: string; advertiser_ids?: string[]; scope?: number[] }>(http, "/oauth2/access_token/", {
      method: "POST",
      json: { app_id: creds.clientId, secret: creds.clientSecret, auth_code: code },
    });
    return { accessToken: d.access_token, extra: { advertiser_ids: d.advertiser_ids ?? [] } };
  },
  async identity(tokens, http) {
    const d = await tiktokJson<{ core_user_id?: string; display_name?: string; email?: string }>(http, "/user/info/", {
      headers: { "Access-Token": tokens.accessToken },
    });
    const account = d.core_user_id ?? d.email ?? "conta-tiktok";
    return { account, label: d.display_name ?? d.email ?? `TikTok ${account}`, metadata: { advertiser_ids: tokens.extra?.advertiser_ids ?? [] } };
  },
};

// ---------------------------------------------------------------------------
// Slack (ferramenta e canal)
// ---------------------------------------------------------------------------

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  // O xodó aparece com o próprio nome nas mensagens dos canais (username no chat.postMessage).
  "chat:write.customize",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "reactions:write",
  "users:read",
];

const slack: OAuthProvider = {
  id: "slack",
  label: "Slack",
  env: { clientId: "SLACK_CLIENT_ID", clientSecret: "SLACK_CLIENT_SECRET" },
  pkce: false,
  authorizeUrl: ({ clientId, redirectUri, state }) =>
    url("https://slack.com/oauth/v2/authorize", { client_id: clientId, scope: SLACK_BOT_SCOPES.join(","), redirect_uri: redirectUri, state }),
  async exchange(code, creds, http) {
    const t = await requestJson<Record<string, unknown>>(http, "https://slack.com/api/oauth.v2.access", {
      method: "POST",
      form: { client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: creds.redirectUri },
    });
    const team = (t.team ?? {}) as { id?: string; name?: string };
    return {
      accessToken: String(t.access_token),
      refreshToken: (t.refresh_token as string) ?? null,
      expiresIn: seconds(t.expires_in),
      scopes: split(t.scope, /,/),
      extra: { team_id: team.id, team_name: team.name, bot_user_id: t.bot_user_id, app_id: t.app_id },
    };
  },
  async refresh(refreshToken, creds, http) {
    const t = await requestJson<Record<string, unknown>>(http, "https://slack.com/api/oauth.v2.access", {
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret },
    });
    return { accessToken: String(t.access_token), refreshToken: (t.refresh_token as string) ?? refreshToken, expiresIn: seconds(t.expires_in) };
  },
  async identity(tokens) {
    const team_id = String(tokens.extra?.team_id ?? "");
    return {
      account: team_id || "slack",
      label: String(tokens.extra?.team_name ?? "Slack"),
      metadata: { team_id, bot_user_id: tokens.extra?.bot_user_id, app_id: tokens.extra?.app_id },
    };
  },
  async revoke(tokens, _creds, http) {
    await requestJson(http, "https://slack.com/api/auth.revoke", { method: "POST", bearer: tokens.accessToken, form: {} });
  },
};

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

const notionBasic = (creds: ClientCreds) => `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`;

const notion: OAuthProvider = {
  id: "notion",
  label: "Notion",
  env: { clientId: "NOTION_CLIENT_ID", clientSecret: "NOTION_CLIENT_SECRET" },
  pkce: false,
  authorizeUrl: ({ clientId, redirectUri, state }) =>
    url("https://api.notion.com/v1/oauth/authorize", { client_id: clientId, response_type: "code", owner: "user", redirect_uri: redirectUri, state }),
  async exchange(code, creds, http) {
    const t = await requestJson<Record<string, unknown>>(http, "https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { authorization: notionBasic(creds) },
      json: { grant_type: "authorization_code", code, redirect_uri: creds.redirectUri },
    });
    return {
      accessToken: String(t.access_token),
      refreshToken: (t.refresh_token as string) ?? null,
      expiresIn: seconds(t.expires_in),
      extra: { workspace_id: t.workspace_id, workspace_name: t.workspace_name, bot_id: t.bot_id },
    };
  },
  async refresh(refreshToken, creds, http) {
    const t = await requestJson<Record<string, unknown>>(http, "https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { authorization: notionBasic(creds) },
      json: { grant_type: "refresh_token", refresh_token: refreshToken },
    });
    return { accessToken: String(t.access_token), refreshToken: (t.refresh_token as string) ?? refreshToken, expiresIn: seconds(t.expires_in) };
  },
  async identity(tokens) {
    const id = String(tokens.extra?.workspace_id ?? "notion");
    return { account: id, label: String(tokens.extra?.workspace_name ?? "Notion"), metadata: { workspace_id: id, bot_id: tokens.extra?.bot_id } };
  },
};

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const github: OAuthProvider = {
  id: "github",
  label: "GitHub",
  env: { clientId: "GITHUB_CLIENT_ID", clientSecret: "GITHUB_CLIENT_SECRET" },
  pkce: false,
  authorizeUrl: ({ clientId, redirectUri, state, scopes }) =>
    url("https://github.com/login/oauth/authorize", { client_id: clientId, redirect_uri: redirectUri, scope: scopes.join(" "), state }),
  async exchange(code, creds, http) {
    const t = await requestJson<Record<string, unknown>>(http, "https://github.com/login/oauth/access_token", {
      method: "POST",
      json: { client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: creds.redirectUri },
    });
    // O GitHub responde 200 com { error } quando o código é inválido.
    if (t.error) throw new IntegrationError(String(t.error_description ?? t.error), 400);
    return {
      accessToken: String(t.access_token),
      refreshToken: (t.refresh_token as string) ?? null,
      expiresIn: seconds(t.expires_in),
      scopes: split(t.scope, /,/),
    };
  },
  async refresh(refreshToken, creds, http) {
    const t = await requestJson<Record<string, unknown>>(http, "https://github.com/login/oauth/access_token", {
      method: "POST",
      json: { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken },
    });
    if (t.error) throw new IntegrationError(String(t.error_description ?? t.error), 401, true);
    return { accessToken: String(t.access_token), refreshToken: (t.refresh_token as string) ?? refreshToken, expiresIn: seconds(t.expires_in) };
  },
  async identity(tokens, http) {
    const me = await requestJson<{ login: string; name?: string }>(http, "https://api.github.com/user", {
      bearer: tokens.accessToken,
      headers: { "user-agent": "Spherum" },
    });
    return { account: me.login, label: me.name ? `${me.name} (@${me.login})` : `@${me.login}` };
  },
};

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = { google, meta, tiktok, slack, notion, github };

export function oauthCreds(provider: OAuthProvider, appUrl: string): ClientCreds {
  const clientId = process.env[provider.env.clientId];
  const clientSecret = process.env[provider.env.clientSecret];
  if (!clientId || !clientSecret) {
    throw new IntegrationError(`O login com ${provider.label} ainda não foi configurado no Spherum (${provider.env.clientId}).`, 503);
  }
  return { clientId, clientSecret, redirectUri: `${appUrl.replace(/\/+$/, "")}/api/integrations/${provider.id}/callback` };
}
