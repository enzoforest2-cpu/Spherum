import assert from "node:assert/strict";
import { test } from "node:test";
import { costUsd, loadPrice, worstCaseUsd } from "../src/lib/xodos/pricing";
import { anthropicUsage } from "../src/lib/xodos/providers";
import { createTestDb } from "./helpers";

test("preços da Anthropic vêm da migração", async () => {
  const { sql } = await createTestDb();
  const opus = await loadPrice(sql, "anthropic", "claude-opus-5-5");
  assert.deepEqual(opus, {
    provider: "anthropic",
    model: "claude-opus-5-5",
    inputPerMtok: 4,
    outputPerMtok: 20,
    cacheReadPerMtok: 0.2,
    version: "2026-10-06",
  });
  assert.equal(await loadPrice(sql, "openai", "qualquer"), null);
});

test("custo soma input, output, leitura e escrita de cache", async () => {
  const price = { provider: "anthropic" as const, model: "m", inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.2, version: "v" };
  // 1M input = 4; 100k output = 2; 500k cache lido = 0,10; 200k cache escrito = 0,2 × 4 × 1,25 = 1
  assert.equal(costUsd(price, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 200_000 }), 7.1);
  // Sem preço de cache, leitura cobra como input.
  assert.equal(costUsd({ ...price, cacheReadPerMtok: null }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }), 4);
});

test("pior caso usa 3 caracteres por token e a saída cheia", () => {
  const price = { provider: "anthropic" as const, model: "m", inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: null, version: "v" };
  // 30.000 caracteres = 10.000 tokens = 0,02; 8.000 de saída = 0,08
  assert.equal(worstCaseUsd(price, 30_000, 8_000), 0.1);
});

test("com fallback do servidor, cada tentativa é cobrada pelo modelo que rodou", () => {
  const slices = anthropicUsage(
    {
      input_tokens: 999,
      output_tokens: 999,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
      ],
    },
    "claude-opus-5-5",
  );
  assert.deepEqual(slices, [
    { model: "claude-opus-5-5", usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { model: "claude-sonnet-5-5", usage: { inputTokens: 100, outputTokens: 300, cacheReadTokens: 10, cacheWriteTokens: 0 } },
  ]);
  // Sem fallback, vale o uso do topo.
  assert.deepEqual(anthropicUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 }, "claude-opus-5-5"), [
    { model: "claude-opus-5-5", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } },
  ]);
});
