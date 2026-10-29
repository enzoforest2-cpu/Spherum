import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { providerErrorMessage, serverLlm } from "../src/lib/xodos/llm";
import { assertPublicUrl, isPublicAddress } from "../src/lib/xodos/net";
import { historyMessages } from "../src/lib/xodos/runner";

test("catálogo amplo: provedores com chave de API, mais local e outra API", () => {
  const llm = serverLlm();
  const ids = llm.providers().map((p) => p.id);
  for (const id of ["anthropic", "openai", "google", "xai", "mistral", "deepseek", "groq", "openrouter", "together", "local", "custom"]) {
    assert.ok(ids.includes(id), `falta ${id}`);
  }
  // Os que pedem credencial de nuvem ou login de assinatura ficam de fora.
  for (const id of ["amazon-bedrock", "azure", "google-vertex", "github-copilot", "openai-codex"]) {
    assert.ok(!ids.includes(id), `não devia ter ${id}`);
  }
  assert.ok(ids.length >= 30);
});

test("modelos do catálogo vêm com janela de contexto e preço", () => {
  const llm = serverLlm();
  const opus = llm.models("anthropic").find((m) => m.id === "claude-opus-5-5");
  assert.ok(opus);
  assert.ok(opus.cost.input > 0 && opus.cost.output > 0);
  assert.ok(opus.contextWindow > 0);
  assert.ok(llm.resolve({ provider: "anthropic", model: "claude-opus-5-5" }));
  assert.equal(llm.resolve({ provider: "anthropic", model: "nao-existe" }), null);
  assert.equal(llm.resolve({ provider: "amazon-bedrock", model: "qualquer" }), null);
});

test("servidor próprio vira um modelo compatível com OpenAI no endereço da agência", () => {
  const llm = serverLlm();
  const model = llm.resolve({ provider: "local", model: "llama3.3:70b", baseUrl: "https://ollama.agencia.com.br/v1/" });
  assert.ok(model);
  assert.deepEqual([model.api, model.baseUrl, model.id], ["openai-completions", "https://ollama.agencia.com.br/v1", "llama3.3:70b"]);
  assert.equal(llm.resolve({ provider: "custom", model: "x" }), null, "sem endereço não há modelo");
});

test("mensagens de erro do provedor em português", () => {
  const fail = (errorMessage: string, raw?: string) => ({
    ...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
    ...(raw ? { rawStopReason: raw } : {}),
  });
  assert.match(providerErrorMessage(fail('401 {"error":"invalid x-api-key"}')), /chave de IA foi recusada/);
  assert.match(providerErrorMessage(fail("429 rate limit")), /limite de uso/);
  assert.match(providerErrorMessage(fail("529 overloaded")), /instável/);
  assert.match(providerErrorMessage(fail("Connection error.")), /Não consegui falar/);
  assert.match(providerErrorMessage(fail("recusou", "refusal")), /se recusou/);
});

test("guarda contra endereços internos", async () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "192.0.2.5", "203.0.113.9", "::1", "fd00::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "192.0.78.9", "203.0.114.10", "198.51.101.1"]) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data"), /rede privada/);
  await assert.rejects(assertPublicUrl("ftp://exemplo.com"), /http\(s\)/);
  await assert.rejects(assertPublicUrl("http://servidor.local/v1"), /locais/);
  // DNS que aponta para rede privada também é barrado.
  await assert.rejects(assertPublicUrl("https://ia.exemplo.com/v1", async () => [{ address: "10.0.0.9" }]), /rede privada/);
  const ok = await assertPublicUrl("https://ia.exemplo.com:8443/v1", async () => [{ address: "203.0.114.10" }]);
  assert.equal(ok.port, "8443");
});

test("histórico visível vira conversa que começa pelo usuário, com falas seguidas juntadas", () => {
  const messages = historyMessages([
    { role: "assistant", text: "Oi! Eu sou Pipoca." },
    { role: "user", text: "a" },
    { role: "user", text: "b" },
    { role: "assistant", text: "" },
    { role: "assistant", text: "c" },
  ]);
  assert.deepEqual(
    messages.map((m) => [m.role, m.role === "user" ? m.content : m.role === "assistant" ? m.content : null]),
    [
      ["user", "a\n\nb"],
      ["assistant", [{ type: "text", text: "c" }]],
    ],
  );
});

test("explica em português sem saldo, chave recusada, modelo sem acesso e limite do plano gratuito", () => {
  const fail = (errorMessage: string) => ({ errorMessage }) as never;
  assert.match(providerErrorMessage(fail("You have no credits remaining. Add credits to continue using the API")), /sem saldo/);
  assert.match(providerErrorMessage(fail('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}')), /chave de IA foi recusada/);
  assert.match(providerErrorMessage(fail("403 Project does not have access to model gpt-x")), /não tem acesso ao modelo/);
  assert.match(providerErrorMessage(fail('{"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 0","status":"RESOURCE_EXHAUSTED"}}')), /uso gratuito/);
});

test("o catálogo esconde modelos que não servem para conversa", () => {
  const ids = serverLlm().models("google").map((m) => m.id);
  assert.ok(!ids.some((id) => /image|live|deep-research|customtools|computer-use/.test(id)));
});
