/**
 * Limpeza de dados sensíveis antes de guardar (memória, entradas de ferramentas). O marcador é
 * sempre "[removido]" e limpar duas vezes dá o mesmo resultado.
 *
 * Versão inicial com os padrões que já existiam; a lista completa (chaves de provedores,
 * tokens de agência, CPF, PIX, URLs com segredo) vem na Etapa 6.
 */

export const REDACTED = "[removido]";

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
];
const LABELLED_SECRET = /\b(senha|password|token|api[ _-]?key|chave de api|secret)(\s*[:=]\s*)(?!\[removido\])\S+/gi;
// Cartões: 4 grupos de 4 ou 15–16 dígitos seguidos começando com 3–6. IDs de campanha
// (Meta com 17–18 dígitos, Google com 10–11) ficam de fora.
const CARD_CANDIDATE = /\b(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}|[3-6]\d{14,15})\b/g;

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Texto sem dados sensíveis e quantos trechos saíram. */
export function redactSecrets(text: string): { text: string; removed: number } {
  let removed = 0;
  const count = (replacement: string) => () => {
    removed += 1;
    return replacement;
  };
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, count(REDACTED));
  out = out.replace(LABELLED_SECRET, (_m, label: string, sep: string) => {
    removed += 1;
    return `${label}${sep}${REDACTED}`;
  });
  out = out.replace(CARD_CANDIDATE, (match) => {
    if (!luhn(match.replace(/\D/g, ""))) return match;
    removed += 1;
    return REDACTED;
  });
  return { text: out, removed };
}

/** Limpa todos os textos de um valor JSON (entradas de ferramentas), mantendo a forma. */
export function redactDeep<T>(value: T): { value: T; removed: number } {
  let removed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v);
      removed += r.removed;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value) as T, removed };
}
