import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { anthropicDriver, googleDriver, normalizeTurns, openaiDriver, type ToolSpec } from "../src/lib/xodos/providers";

const tools: ToolSpec[] = [{ name: "listar_clientes", description: "Lista", parameters: { type: "object", properties: {} } }];
const results = [{ id: "c1", name: "listar_clientes", content: "[]", isError: false }];

/** Cliente falso: guarda o corpo enviado e devolve a resposta pronta. */
function capture<T>(response: unknown) {
  const calls: T[] = [];
  const fn = async (body: T) => {
    calls.push(body);
    return response;
  };
  return { calls, fn };
}

test("conversa começa pelo usuário e junta falas seguidas", () => {
  assert.deepEqual(
    normalizeTurns([
      { role: "assistant", text: "Oi! Eu sou Faísca." },
      { role: "user", text: "a" },
      { role: "user", text: "b" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "c" },
    ]),
    [
      { role: "user", text: "a\n\nb" },
      { role: "assistant", text: "c" },
    ],
  );
});

test("Anthropic: fallback do servidor, cache, raciocínio preservado e ferramentas", async () => {
  const content = [
    { type: "thinking", thinking: "...", signature: "sig" },
    { type: "text", text: "Vou listar." },
    { type: "tool_use", id: "c1", name: "listar_clientes", input: {} },
  ];
  const { calls, fn } = capture<Record<string, unknown>>({
    content,
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  });
  const client = { beta: { messages: { create: fn } } } as unknown as Anthropic;
  const driver = anthropicDriver(client, "claude-opus-5-5");
  const history = driver.start([{ role: "user", text: "Clientes?" }]);
  const step = await driver.step({ system: "sys", history, tools, maxTokens: 8000 });

  const body = calls[0];
  assert.deepEqual(body.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.tool_choice, undefined, "tool_choice forçado não é usado");
  assert.deepEqual(body.tools, [{ name: "listar_clientes", description: "Lista", input_schema: { type: "object", properties: {} } }]);
  assert.equal(step.stop, "tool_use");
  assert.equal(step.text, "Vou listar.");
  assert.deepEqual(step.toolCalls, [{ id: "c1", name: "listar_clientes", input: {} }]);
  // A resposta inteira (com o bloco de raciocínio) volta para a conversa.
  assert.deepEqual(step.history.at(-1), { role: "assistant", content });
  assert.deepEqual(step.usage, [{ model: "claude-opus-5-5", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 } }]);
  assert.deepEqual(driver.addToolResults(step.history, results).at(-1), {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "c1", content: "[]", is_error: false }],
  });
});

test("Anthropic: recusa e corte por tamanho", async () => {
  for (const [stop_reason, expected] of [["refusal", "refusal"], ["max_tokens", "max_tokens"], ["end_turn", "end"]] as const) {
    const { fn } = capture({ content: [{ type: "text", text: "x" }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });
    const driver = anthropicDriver({ beta: { messages: { create: fn } } } as unknown as Anthropic, "claude-opus-5-5");
    assert.equal((await driver.step({ system: "", history: [], tools, maxTokens: 10 })).stop, expected);
  }
});

test("OpenAI e xAI: chamadas de função, argumentos inválidos e cache descontado do input", async () => {
  const { calls, fn } = capture<Record<string, unknown>>({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          refusal: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "listar_clientes", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "listar_clientes", arguments: "{quebrado" } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
  });
  const driver = openaiDriver({ chat: { completions: { create: fn } } } as unknown as OpenAI, "modelo-da-agencia", "xai");
  const step = await driver.step({ system: "sys", history: driver.start([{ role: "user", text: "oi" }]), tools, maxTokens: 500 });

  const body = calls[0];
  assert.deepEqual((body.messages as unknown[])[0], { role: "system", content: "sys" });
  assert.equal(body.max_completion_tokens, 500);
  assert.equal(driver.provider, "xai");
  assert.equal(step.stop, "tool_use");
  assert.deepEqual(step.toolCalls[1].input, { __argumentos_invalidos: "{quebrado" });
  assert.deepEqual(step.usage[0].usage, { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 });
  assert.deepEqual(driver.addToolResults(step.history, [{ ...results[0], isError: true, content: "falhou" }]).at(-1), {
    role: "tool",
    tool_call_id: "c1",
    content: "ERRO: falhou",
  });
});

test("Gemini: chamadas de função, ids gerados não voltam para a API e pensamento conta como saída", async () => {
  const parts = [
    { text: "pensando", thought: true },
    { text: "Vou ver." },
    { functionCall: { name: "listar_clientes", args: {} }, thoughtSignature: "assinatura" },
  ];
  const { calls, fn } = capture<Record<string, unknown>>({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 60 },
  });
  const driver = googleDriver({ models: { generateContent: fn } } as unknown as GoogleGenAI, "gemini-da-agencia");
  const history = driver.start([{ role: "assistant", text: "oi" }, { role: "user", text: "Clientes?" }]);
  assert.deepEqual(history, [{ role: "user", parts: [{ text: "Clientes?" }] }]);
  const step = await driver.step({ system: "sys", history, tools, maxTokens: 900 });

  const config = calls[0].config as Record<string, unknown>;
  assert.equal(config.systemInstruction, "sys");
  assert.equal(config.maxOutputTokens, 900);
  assert.deepEqual((config.tools as { functionDeclarations: unknown[] }[])[0].functionDeclarations[0], {
    name: "listar_clientes",
    description: "Lista",
    parametersJsonSchema: { type: "object", properties: {} },
  });
  assert.equal(step.text, "Vou ver.");
  assert.equal(step.stop, "tool_use");
  // As partes voltam intactas, com a assinatura de pensamento.
  assert.deepEqual(step.history.at(-1), { role: "model", parts });
  assert.deepEqual(step.usage[0].usage, { inputTokens: 400, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0 });
  const response = driver.addToolResults(step.history, [{ id: step.toolCalls[0].id, name: "listar_clientes", content: "[]", isError: false }]).at(-1);
  assert.deepEqual(response, { role: "user", parts: [{ functionResponse: { name: "listar_clientes", response: { output: "[]" } } }] });
});

test("Gemini: bloqueio de segurança vira recusa", async () => {
  const { fn } = capture({ candidates: [{ finishReason: "SAFETY" }], usageMetadata: {} });
  const driver = googleDriver({ models: { generateContent: fn } } as unknown as GoogleGenAI, "g");
  assert.equal((await driver.step({ system: "", history: [], tools, maxTokens: 10 })).stop, "refusal");
});
