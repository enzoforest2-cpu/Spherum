import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Custo das chamadas. O custo real vem pronto da biblioteca de modelos (usage.cost, em US$,
 * com as faixas de preço do catálogo); aqui só estimamos o pior caso para o teto opcional.
 */

/** Estimativa conservadora de tokens a partir de caracteres (3 por token, em vez dos ~4 usuais). */
const CHARS_PER_TOKEN = 3;

/** Pior caso de uma chamada em US$: todo o prompt sem cache e a saída inteira até maxTokens. */
export function worstCaseUsd(model: Model<Api>, promptChars: number, maxOutputTokens: number): number {
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  return round6((inputTokens * model.cost.input + maxOutputTokens * model.cost.output) / 1_000_000);
}

export function hasKnownPrice(model: Model<Api>): boolean {
  return model.cost.input > 0 || model.cost.output > 0;
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
