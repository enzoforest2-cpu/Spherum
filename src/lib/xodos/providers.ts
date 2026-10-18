import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import type { Provider, ToolCall, ToolResult, Usage, UsageSlice } from "./types";

/**
 * Um adaptador por provedor, todos com a mesma cara para o executor.
 *
 * A conversa fica no formato nativo de cada provedor (native_messages) e volta inteira a
 * cada passo: na Anthropic isso preserva os blocos de raciocínio e de fallback, no Gemini
 * as assinaturas de pensamento. Nada de converter entre formatos no meio de uma execução.
 */

export type Turn = { role: "user" | "assistant"; text: string };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type StepRequest = { system: string; history: unknown[]; tools: ToolSpec[]; maxTokens: number };

export type StepResponse = {
  /** history recebido mais a resposta do modelo, no formato nativo. */
  history: unknown[];
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  /** Uso por modelo que de fato atendeu (com fallback, pode haver mais de um). */
  usage: UsageSlice[];
};

export interface ModelDriver {
  provider: Provider;
  model: string;
  start(turns: Turn[]): unknown[];
  step(req: StepRequest): Promise<StepResponse>;
  addToolResults(history: unknown[], results: ToolResult[]): unknown[];
}

/** Junta falas seguidas do mesmo lado e garante que a conversa começa pelo usuário. */
export function normalizeTurns(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const turn of turns) {
    if (!turn.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.text += `\n\n${turn.text}`;
    else out.push({ ...turn });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function parseArgs(raw: string | null | undefined): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { __argumentos_invalidos: raw };
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export function anthropicDriver(client: Anthropic, model: string): ModelDriver {
  return {
    provider: "anthropic",
    model,
    start(turns) {
      return normalizeTurns(turns).map((t) => ({ role: t.role, content: t.text }));
    },
    async step(req) {
      const res = await client.beta.messages.create({
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.history as Anthropic.Beta.BetaMessageParam[],
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
        })),
        // Cacheia o prefixo (sistema, ferramentas e conversa até aqui) entre os passos.
        cache_control: { type: "ephemeral" },
        // Se o modelo recusar por política, o servidor tenta o fallback padrão dele.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const toolCalls = res.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      const stop =
        res.stop_reason === "refusal"
          ? "refusal"
          : res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded"
            ? "max_tokens"
            : toolCalls.length
              ? "tool_use"
              : "end";
      return {
        history: [...req.history, { role: "assistant", content: res.content }],
        text,
        toolCalls,
        stop,
        usage: anthropicUsage(res.usage, model),
      };
    },
    addToolResults(history, results) {
      return [
        ...history,
        {
          role: "user",
          content: results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
            is_error: r.isError,
          })),
        },
      ];
    },
  };
}

type AnthropicUsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  iterations?: Array<{
    type: string;
    model?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  }> | null;
};

/** Com fallback, cada tentativa vem em usage.iterations e é cobrada pelo modelo que rodou. */
export function anthropicUsage(usage: AnthropicUsageLike, requestedModel: string): UsageSlice[] {
  const toUsage = (u: Omit<NonNullable<AnthropicUsageLike["iterations"]>[number], "type" | "model">): Usage => ({
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  });
  const iterations = (usage.iterations ?? []).filter((it) => it.type === "message" || it.type === "fallback_message");
  if (!iterations.some((it) => it.type === "fallback_message")) {
    return [{ model: requestedModel, usage: toUsage(usage) }];
  }
  return iterations.map((it) => ({
    model: it.model ?? requestedModel,
    usage: toUsage(it),
  }));
}

// ---------------------------------------------------------------------------
// OpenAI e xAI (Chat Completions; a xAI usa a mesma API em api.x.ai)
// ---------------------------------------------------------------------------

export function openaiDriver(client: OpenAI, model: string, provider: "openai" | "xai" = "openai"): ModelDriver {
  return {
    provider,
    model,
    start(turns) {
      return normalizeTurns(turns).map((t) => ({ role: t.role, content: t.text }));
    },
    async step(req) {
      const res = await client.chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          ...(req.history as OpenAI.Chat.ChatCompletionMessageParam[]),
        ],
        tools: req.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      });
      const choice = res.choices[0];
      const msg = choice?.message;
      const calls = (msg?.tool_calls ?? []).flatMap((c) => (c.type === "function" ? [c] : []));
      const toolCalls = calls.map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) }));
      const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: "assistant", content: msg?.content ?? "" };
      if (calls.length) assistant.tool_calls = calls;
      const refused = !msg || Boolean(msg.refusal) || choice.finish_reason === "content_filter";
      const stop = refused
        ? "refusal"
        : choice.finish_reason === "length"
          ? "max_tokens"
          : toolCalls.length
            ? "tool_use"
            : "end";
      const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        history: [...req.history, assistant],
        text: msg?.content ?? msg?.refusal ?? "",
        toolCalls,
        stop,
        usage: [
          {
            model,
            usage: {
              inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
              outputTokens: res.usage?.completion_tokens ?? 0,
              cacheReadTokens: cached,
              cacheWriteTokens: 0,
            },
          },
        ],
      };
    },
    addToolResults(history, results) {
      return [
        ...history,
        ...results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERRO: ${r.content}` : r.content })),
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Google (Gemini)
// ---------------------------------------------------------------------------

type GeminiPart = {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  [k: string]: unknown;
};
type GeminiContent = { role?: string; parts?: GeminiPart[] };

/** Ids que nós inventamos (o Gemini nem sempre manda um) não voltam para a API. */
const GENERATED_ID = "gerado_";

const GEMINI_REFUSALS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

export function googleDriver(ai: GoogleGenAI, model: string): ModelDriver {
  return {
    provider: "google",
    model,
    start(turns) {
      return normalizeTurns(turns).map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] }));
    },
    async step(req) {
      const res = await ai.models.generateContent({
        model,
        contents: req.history as GeminiContent[],
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxTokens,
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        },
      });
      const candidate = res.candidates?.[0];
      const content = (candidate?.content ?? { role: "model", parts: [] }) as GeminiContent;
      const parts = content.parts ?? [];
      const text = parts.flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join("");
      const toolCalls = parts.flatMap((p, i) =>
        p.functionCall?.name
          ? [{ id: p.functionCall.id ?? `${GENERATED_ID}${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} }]
          : [],
      );
      const reason = String(candidate?.finishReason ?? "");
      const refused = !candidate || Boolean(res.promptFeedback?.blockReason) || GEMINI_REFUSALS.has(reason);
      const stop = refused ? "refusal" : reason === "MAX_TOKENS" ? "max_tokens" : toolCalls.length ? "tool_use" : "end";
      const meta = res.usageMetadata;
      const cached = meta?.cachedContentTokenCount ?? 0;
      return {
        history: [...req.history, { role: "model", parts }],
        text,
        toolCalls,
        stop,
        usage: [
          {
            model,
            usage: {
              inputTokens: Math.max(0, (meta?.promptTokenCount ?? 0) - cached),
              outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
              cacheReadTokens: cached,
              cacheWriteTokens: 0,
            },
          },
        ],
      };
    },
    addToolResults(history, results) {
      return [
        ...history,
        {
          role: "user",
          parts: results.map((r) => ({
            functionResponse: {
              ...(r.id.startsWith(GENERATED_ID) ? {} : { id: r.id }),
              name: r.name,
              response: r.isError ? { error: r.content } : { output: r.content },
            },
          })),
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------

export async function createDriver(provider: Provider, model: string, apiKey: string): Promise<ModelDriver> {
  const options = { apiKey, timeout: 120_000, maxRetries: 2 };
  switch (provider) {
    case "anthropic": {
      const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
      return anthropicDriver(new AnthropicClient(options), model);
    }
    case "openai": {
      const { default: OpenAIClient } = await import("openai");
      return openaiDriver(new OpenAIClient(options), model, "openai");
    }
    case "xai": {
      const { default: OpenAIClient } = await import("openai");
      return openaiDriver(new OpenAIClient({ ...options, baseURL: "https://api.x.ai/v1" }), model, "xai");
    }
    case "google": {
      const { GoogleGenAI: GoogleClient } = await import("@google/genai");
      return googleDriver(new GoogleClient({ apiKey, httpOptions: { timeout: 120_000 } }), model);
    }
  }
}
