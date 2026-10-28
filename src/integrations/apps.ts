/**
 * Catálogo de apps que um xodó pode usar e de onde vem o login de cada um.
 *
 * Os apps do passo "Limites" do design (Gmail, Agenda, Slack, WhatsApp, Notion, GitHub,
 * Drive), as plataformas de anúncio e análise do Spherum, e servidores MCP genéricos.
 */

export const PROVIDERS = [
  "google",
  "meta",
  "tiktok",
  "slack",
  "notion",
  "github",
  "telegram",
  "whatsapp_cloud",
  "whatsapp_qr",
  "mcp",
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export type AppId =
  | "gmail"
  | "calendar"
  | "drive"
  | "google_ads"
  | "ga4"
  | "meta_ads"
  | "meta_social"
  | "tiktok_ads"
  | "slack"
  | "notion"
  | "github"
  | "whatsapp"
  | "telegram"
  | "mcp";

export type AppInfo = {
  label: string;
  /** De quais conexões o app pode vir (o WhatsApp tem a API oficial e o QR Code). */
  providers: ProviderId[];
  /** Permissões OAuth que o app precisa naquele provedor. */
  scopes: string[];
};

const G = "https://www.googleapis.com/auth/";

export const APPS: Record<AppId, AppInfo> = {
  gmail: { label: "Gmail", providers: ["google"], scopes: [`${G}gmail.modify`] },
  calendar: { label: "Agenda", providers: ["google"], scopes: [`${G}calendar.events`] },
  drive: { label: "Drive", providers: ["google"], scopes: [`${G}drive.readonly`, `${G}drive.file`] },
  google_ads: { label: "Google Ads", providers: ["google"], scopes: [`${G}adwords`] },
  ga4: { label: "Google Analytics 4", providers: ["google"], scopes: [`${G}analytics.readonly`] },
  meta_ads: { label: "Meta Ads", providers: ["meta"], scopes: ["ads_read", "ads_management", "business_management"] },
  // Publicar nos perfis dos clientes (Conteúdo e Publicar).
  meta_social: {
    label: "Instagram e Facebook",
    providers: ["meta"],
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish", "business_management"],
  },
  tiktok_ads: { label: "TikTok Ads", providers: ["tiktok"], scopes: [] },
  slack: { label: "Slack", providers: ["slack"], scopes: [] },
  notion: { label: "Notion", providers: ["notion"], scopes: [] },
  github: { label: "GitHub", providers: ["github"], scopes: ["repo", "read:user", "read:org"] },
  whatsapp: { label: "WhatsApp", providers: ["whatsapp_cloud", "whatsapp_qr"], scopes: [] },
  telegram: { label: "Telegram", providers: ["telegram"], scopes: [] },
  mcp: { label: "Servidor MCP", providers: ["mcp"], scopes: [] },
};

export const APP_IDS = Object.keys(APPS) as AppId[];

export function isAppId(value: string): value is AppId {
  return (APP_IDS as string[]).includes(value);
}

/** Permissões que faltam numa conexão para o app funcionar. */
export function missingScopes(app: AppId, granted: string[]): string[] {
  return APPS[app].scopes.filter((s) => !granted.includes(s));
}
