import { XodoError } from "./errors";

/**
 * Confere uma chave de IA na hora de guardar, com a listagem de modelos do provedor (não gasta
 * tokens). Chave recusada (401/403) não é guardada. Provedor fora do ar, ou provedor que não
 * está nesta lista, não impede: a chave fica e o primeiro uso diz se funciona.
 */

type Check = { url: string; headers: (key: string) => Record<string, string> };

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const CHECKS: Record<string, Check> = {
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=1", headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }) },
  openai: { url: "https://api.openai.com/v1/models", headers: bearer },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: (key) => ({ "x-goog-api-key": key }) },
  xai: { url: "https://api.x.ai/v1/models", headers: bearer },
  deepseek: { url: "https://api.deepseek.com/models", headers: bearer },
  mistral: { url: "https://api.mistral.ai/v1/models", headers: bearer },
  openrouter: { url: "https://openrouter.ai/api/v1/key", headers: bearer },
  groq: { url: "https://api.groq.com/openai/v1/models", headers: bearer },
};

export type KeyCheck = { checked: boolean; note?: string };

export async function checkAiKey(provider: string, key: string, http: typeof fetch): Promise<KeyCheck> {
  const check = CHECKS[provider];
  if (!check) return { checked: false };
  let response: Response;
  try {
    response = await http(check.url, { headers: check.headers(key), signal: AbortSignal.timeout(10_000) });
  } catch {
    return { checked: false, note: "Não consegui falar com o provedor agora; a chave foi guardada e o primeiro uso confirma." };
  }
  if (response.status === 401 || response.status === 403) {
    throw new XodoError("O provedor recusou essa chave. Confira se copiou inteira e se ela está ativa.", 400);
  }
  if (response.status === 429) return { checked: true, note: "A chave funciona, mas o provedor está limitando as chamadas agora." };
  if (!response.ok) return { checked: false, note: `O provedor respondeu ${response.status}; a chave foi guardada e o primeiro uso confirma.` };
  return { checked: true };
}
