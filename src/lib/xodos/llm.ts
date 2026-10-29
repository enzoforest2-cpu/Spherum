import {
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Camada de modelos dos Xodós, sobre a biblioteca pi-ai (a mesma que o Rakazo usa).
 *
 * Ela traz o catálogo de provedores e modelos com preço, fala o protocolo de cada um e
 * guarda a conversa num formato único, o que permite que um modelo reserva de outro
 * provedor assuma no meio da tarefa. A chave da agência vai em cada chamada.
 */

/** Servidores próprios compatíveis com OpenAI: "local" (Ollama, LM Studio) e "custom" (outra API). */
export const SELF_HOSTED = ["local", "custom"] as const;
export type SelfHosted = (typeof SELF_HOSTED)[number];

/** Provedores do catálogo que pedem credencial de nuvem ou login de assinatura, não uma chave de API. */
const NOT_API_KEY = new Set([
  "amazon-bedrock",
  "azure",
  "google-vertex",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "github-copilot",
  "openai-codex",
  "typesafe",
]);

export type ModelRef = { provider: string; model: string; baseUrl?: string | null };

export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** US$ por milhão de tokens. */
  cost: { input: number; output: number; cacheRead: number };
};

export type CompleteOptions = { apiKey?: string; maxTokens: number; signal?: AbortSignal };

export interface LlmClient {
  /** Modelo do catálogo, ou montado para um servidor próprio. Nulo se não existir. */
  resolve(ref: ModelRef): Model<Api> | null;
  complete(model: Model<Api>, context: Context, options: CompleteOptions): Promise<AssistantMessage>;
  providers(): { id: string; name: string }[];
  models(provider: string): CatalogModel[];
}

const NOT_CHAT = /image|live|tts|audio|realtime|computer-use|deep-research|customtools|embedding|transcribe|search/i;

export function isSelfHosted(provider: string): provider is SelfHosted {
  return (SELF_HOSTED as readonly string[]).includes(provider);
}

function selfHostedModel(ref: ModelRef): Model<Api> | null {
  if (!ref.baseUrl) return null;
  return {
    id: ref.model,
    name: ref.model,
    api: "openai-completions",
    provider: ref.provider,
    baseUrl: ref.baseUrl.replace(/\/+$/, ""),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as Model<Api>;
}

/** Monta o cliente a partir de uma coleção da pi-ai (no servidor, com todos os provedores). */
export function llmFromModels(models: MutableModels): LlmClient {
  for (const id of SELF_HOSTED) {
    models.setProvider(
      createProvider({
        id,
        name: id === "local" ? "Local (Ollama, LM Studio)" : "Outra API compatível com OpenAI",
        // A chave, quando existe, vem em cada chamada.
        auth: { apiKey: { name: id, resolve: async () => ({ auth: {} }) } },
        models: [],
        api: openAICompletionsApi(),
      }),
    );
  }
  return {
    resolve(ref) {
      if (isSelfHosted(ref.provider)) return selfHostedModel(ref);
      if (NOT_API_KEY.has(ref.provider)) return null;
      return models.getModel(ref.provider, ref.model) ?? null;
    },
    complete(model, context, options) {
      return models.complete(model, context, {
        // Servidor no próprio computador (Ollama, LM Studio) costuma não ter chave; a biblioteca exige uma.
        apiKey: options.apiKey || (isSelfHosted(model.provider) ? "sem-chave" : undefined),
        maxTokens: options.maxTokens,
        signal: options.signal,
      });
    },
    providers() {
      const catalog = models
        .getProviders()
        .filter((p) => !NOT_API_KEY.has(p.id) && !isSelfHosted(p.id) && models.getModels(p.id).length > 0)
        .map((p) => ({ id: p.id, name: p.name ?? p.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return [
        ...catalog,
        { id: "local", name: "Local (Ollama, LM Studio)" },
        { id: "custom", name: "Outra API compatível com OpenAI" },
      ];
    },
    models(provider) {
      if (NOT_API_KEY.has(provider) || isSelfHosted(provider)) return [];
      return models
        .getModels(provider)
        // Fora os modelos que não servem para conversa com ferramentas (imagem, voz, pesquisa pronta...).
        .filter((m) => !NOT_CHAT.test(m.id))
        .map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
        cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead },
      }));
    },
  };
}

let shared: LlmClient | null = null;

export function serverLlm(): LlmClient {
  shared ??= llmFromModels(builtinModels());
  return shared;
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/** Mensagem curta, em português, para uma falha do provedor (a pi-ai devolve "401 {...}" etc.). */
export function providerErrorMessage(message: AssistantMessage | undefined | null): string {
  const raw = message?.errorMessage ?? "";
  if (message?.rawStopReason === "refusal") return "O modelo se recusou a fazer este pedido.";
  const status = Number(raw.match(/^(\d{3})\b/)?.[1] ?? raw.match(/"code":\s*(\d{3})/)?.[1] ?? 0);
  // Os provedores escrevem o motivo em inglês; os mais comuns viram instrução em português.
  if (/no credits|credit balance|insufficient_quota|billing/i.test(raw)) {
    return "Sua conta no provedor de IA está sem saldo. Entre no site do provedor, na parte de cobrança (Billing), coloque créditos e tente de novo.";
  }
  // A OpenAI responde 403/404 quando a chave é boa mas o projeto não tem acesso ao modelo.
  if (/does not have access to model|model_not_found|model .{0,80} does not exist|not found for API version|unsupported model/i.test(raw)) {
    return "Sua chave não tem acesso ao modelo escolhido. Nos ajustes do xodó, troque o modelo (ou libere esse modelo no site do provedor).";
  }
  if (/api key not valid|api_key_invalid|incorrect api key|invalid.{0,10}api.?key/i.test(raw) || status === 401 || status === 403) {
    return "A chave de IA foi recusada pelo provedor. Confira a chave de IA da agência: se foi copiada inteira e se ainda está ativa.";
  }
  if (/limit:\s*0\b/i.test(raw)) {
    return "Este modelo não está liberado no uso gratuito da sua chave. Nos ajustes do xodó, troque para um modelo \"Flash\" ou ative a cobrança no provedor.";
  }
  if (status === 429 || /resource_exhausted|quota/i.test(raw)) {
    return "A sua chave chegou no limite de uso do provedor (no plano gratuito, o limite é por minuto e por dia). Espere um pouco e tente de novo.";
  }
  if (status === 404) return "O provedor não encontrou o modelo configurado.";
  if (status >= 500) return "O provedor do modelo está instável agora. Tente de novo em instantes.";
  if (/connection|fetch failed|ECONN|ENOTFOUND|timed? ?out/i.test(raw)) return "Não consegui falar com o provedor do modelo.";
  return `Falha ao chamar o modelo: ${raw.slice(0, 300) || "erro desconhecido"}`;
}
