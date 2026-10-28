import type { Category } from "../xodos/policy";

/**
 * Classifica ferramentas de terceiros (servidores MCP e conectores genéricos), que chegam
 * às dezenas com nomes como GMAIL_SEND_EMAIL ou notion-create-page. A categoria decide a
 * aprovação conforme a autonomia do xodó.
 *
 * Adaptado de shared/outbound.ts do OpenMausBot (verbos de envio, "criar mensagem é enviar",
 * verbo de leitura no começo) e de action-approval.ts do Rakazo (o aviso de "só leitura" do
 * servidor nunca alivia o que o nome diz; na dúvida, não é leitura).
 */

const READ = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT", "QUERY", "DESCRIBE", "SHOW", "STATUS", "EXPORT"]);
const SEND = new Set(["SEND", "SENDS", "REPLY", "RESPOND", "FORWARD", "POST", "PUBLISH", "TWEET", "RETWEET", "BROADCAST", "INVITE", "SHARE", "NOTIFY", "MESSAGE", "EMAIL", "SMS", "DM"]);
const PAY = new Set(["PAY", "PAYOUT", "CHARGE", "REFUND", "TRANSFER", "PURCHASE", "BUY", "CHECKOUT", "SUBSCRIBE", "BILL"]);
const DELETE = new Set(["DELETE", "REMOVE", "DESTROY", "PURGE", "TRASH", "ARCHIVE", "ERASE", "WIPE", "DROP", "UNINSTALL", "REVOKE"]);
const CREATE = new Set(["CREATE", "CREATION", "ADD", "NEW", "INSERT"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM", "INVITATION", "INVITE"]);

/** Palavras do nome da ação, em maiúsculas. Tira prefixos de app (GMAIL_, mcp__servidor__). */
export function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) action = name.split("__").slice(2).join("_");
  else if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) action = name.slice(name.indexOf("_") + 1);
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean };

export function classifyExternalTool(name: string, hints: ToolHints = {}): Category {
  const tokens = actionTokens(name);
  const has = (set: Set<string>) => tokens.some((t) => set.has(t));
  const readFirst = tokens.length > 0 && READ.has(tokens[0]);

  if (hints.destructiveHint || (!readFirst && has(DELETE))) return "exclusao";
  if (!readFirst && has(PAY)) return "pagamento";
  if (!readFirst && (has(SEND) || (has(CREATE) && has(SENT_NOUNS))) && !tokens.includes("DRAFT")) return "envio";
  // Leitura só quando o nome diz que é leitura. O aviso do servidor sozinho não basta.
  if (readFirst) return "leitura";
  return "alteracao";
}
