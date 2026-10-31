/**
 * Regras das notas de memória (adaptadas do OpenMausBot, server/memory-entries.ts, Apache-2.0).
 */

export type MemoryKind = "preferencia" | "fato" | "decisao" | "resultado";
export const MEMORY_KINDS: MemoryKind[] = ["preferencia", "fato", "decisao", "resultado"];

export type MemorySource = "xodo" | "captura" | "equipe" | "arrumacao" | "importacao";
export type MemoryStatus = "ativo" | "proposto" | "substituido" | "expirado" | "arquivado" | "apagado";
export type MemoryActor = "xodo" | "captura" | "equipe" | "arrumacao" | "sistema";

/** Tamanho máximo de uma nota (já sem dados sensíveis). */
export const NOTE_MAX_CHARS = 1000;
/** Tópico cheio: acima disso, o xodó precisa resumir antes de acrescentar. */
export const TOPIC_MAX_NOTES = 200;
export const TOPIC_MAX_CHARS = 64_000;

const RESERVED_TOPICS = new Set(["nucleo", "arquivo", "memoria"]);

/** Sem acento e em minúsculas (espelho de public.xodo_fold). */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[áàâãä]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i")
    .replace(/[óòôõö]/g, "o")
    .replace(/[úùûü]/g, "u")
    .replace(/ç/g, "c")
    .replace(/ñ/g, "n");
}

const LIST_MARKER = /^([-*•]|[0-9]+[.)])\s+/;

/** Tira o marcador de lista do começo ("- ", "1. "): a nota é o fato, não o item. */
export const stripListMarker = (text: string) => text.trim().replace(LIST_MARKER, "");

/**
 * Identidade de uma nota (espelho de public.xodo_fact_identity): o mesmo fato com outra
 * caixa, acento, espaços ou ponto final não vira nota repetida.
 */
export function factIdentity(text: string): string {
  return fold(text.normalize("NFC").trim())
    .replace(LIST_MARKER, "")
    .replace(/\s+/g, " ")
    .replace(/[.!;]+$/, "");
}

/** Nome de tópico em slug ("Black Friday da Acme" → "black-friday-da-acme"); nulo se não sobrar nada válido. */
export function slugTopic(name: string): string | null {
  const slug = fold(name.normalize("NFC"))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (!slug || RESERVED_TOPICS.has(slug)) return null;
  return slug;
}

export const isMemoryDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/**
 * O que nunca sai do núcleo para abrir espaço: saúde, restrições, compliance e proibições
 * (ideia do ALWAYS_CORE do OpenMausBot, com o vocabulário de agência).
 */
export const SEMPRE_NUCLEO =
  /\b(alerg|intoler|vegan|vegetarian|halal|kosher|gl[uú]ten|lactose|diabet|sa[uú]de|gestant|acessibil|defici[eê]n|lgpd|anvisa|conar|jur[ií]dic|compliance|proibid|nunca (usar|mencionar|publicar|prometer)|n[aã]o (usar|mencionar|publicar|prometer))/i;
