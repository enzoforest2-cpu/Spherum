import { num, one, type Sql } from "./db";
import type { Provider, Usage } from "./types";

export type Price = {
  provider: Provider;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number | null;
  version: string;
};

/** Gravar no cache custa 1,25x o input (cache de 5 minutos da Anthropic). */
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Estimativa conservadora de tokens a partir de caracteres (3 por token, em vez dos ~4 usuais). */
const CHARS_PER_TOKEN = 3;

export async function loadPrice(sql: Sql, provider: Provider, model: string): Promise<Price | null> {
  const row = await one(
    sql,
    `select provider, model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, pricing_version
       from ai_model_prices where provider = $1 and model = $2`,
    [provider, model],
  );
  if (!row) return null;
  return {
    provider,
    model,
    inputPerMtok: num(row.input_usd_per_mtok),
    outputPerMtok: num(row.output_usd_per_mtok),
    cacheReadPerMtok: row.cache_read_usd_per_mtok === null ? null : num(row.cache_read_usd_per_mtok),
    version: String(row.pricing_version),
  };
}

export function costUsd(price: Price, usage: Usage): number {
  const perMtok =
    usage.inputTokens * price.inputPerMtok +
    usage.outputTokens * price.outputPerMtok +
    usage.cacheReadTokens * (price.cacheReadPerMtok ?? price.inputPerMtok) +
    usage.cacheWriteTokens * price.inputPerMtok * CACHE_WRITE_MULTIPLIER;
  return round6(perMtok / 1_000_000);
}

/** Pior caso de uma chamada: todo o prompt sem cache e a saída inteira até max_tokens. */
export function worstCaseUsd(price: Price, promptChars: number, maxOutputTokens: number): number {
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  return costUsd(price, { inputTokens, outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
