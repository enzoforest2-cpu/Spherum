import type { Category } from "../../xodos/policy";
import type { ToolDef } from "../../xodos/tools";

/** Ajudas dos conectores de apps: texto legível a partir de HTML, cortes e endereços de e-mail. */

export function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

/** Corta texto longo para caber no contexto do modelo. */
export function clip(text: string, max = 12_000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cortado: ${text.length - max} caracteres a mais)` : text;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML de e-mail ou documento em texto simples, mantendo parágrafos e links. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label} (${href})`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Endereços de um cabeçalho como "Ana <ana@x.com>, bia@y.com". */
export function addresses(header: string | null | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
}

/** Provedores de e-mail abertos: mesmo domínio ali não quer dizer mesma empresa. */
const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "globo.com",
  "zoho.com",
  "gmx.com",
]);

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Quem recebe é só gente da própria empresa? Vale quando todos os endereços são do domínio da
 * conta conectada e ele não é um provedor aberto (gmail.com etc.).
 */
export function internalOnly(account: string, recipients: string[]): boolean {
  if (!recipients.length || !account.includes("@")) return false;
  const own = domainOf(account);
  if (PUBLIC_DOMAINS.has(own)) return false;
  return recipients.every((r) => domainOf(r) === own);
}

/** "equipe" quando fica dentro da empresa; senão, "envio". */
export const audience = (internal: boolean): Category => (internal ? "equipe" : "envio");
