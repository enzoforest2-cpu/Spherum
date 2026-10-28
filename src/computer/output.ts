import { redactSecrets } from "../xodos/redact";

/**
 * Saídas do computador antes de voltarem ao modelo ou ao banco: primeiro a limpeza de dados
 * sensíveis (para não sobrar meia chave num corte), depois o corte com aviso.
 */

/** Fica com o fim (saída de terminal: o que importa costuma estar no final). */
export function tailText(text: string, max: number): string {
  const clean = redactSecrets(text).text;
  if (clean.length <= max) return clean;
  return `CORTADO: mostrei os últimos ${max} de ${clean.length} caracteres; peça um trecho se precisar.\n…${clean.slice(-max)}`;
}

/** Fica com o começo (página, arquivo). */
export function headText(text: string, max: number): string {
  const clean = redactSecrets(text).text;
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n… CORTADO: mostrei ${max} de ${clean.length} caracteres; peça o resto com offset.`;
}

/** Texto seguro para entrar num comando de shell entre aspas simples. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
