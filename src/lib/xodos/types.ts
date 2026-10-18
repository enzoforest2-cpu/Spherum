export const PROVIDERS = ["anthropic", "openai", "google", "xai"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const SPECIES = ["pingo", "bibo", "oki"] as const;
export const PERSONALITIES = ["curioso", "brincalhao", "direto", "zen"] as const;
export const ROLES = ["relatorios", "alertas", "otimizacao", "geral"] as const;

export type Personality = (typeof PERSONALITIES)[number];
export type Role = (typeof ROLES)[number];

export type Xodo = {
  id: string;
  agency_id: string;
  name: string;
  species: (typeof SPECIES)[number];
  color: string;
  personality: Personality;
  role: Role;
  instructions: string;
  provider: Provider;
  model: string;
  credential_id: string | null;
  daily_budget_usd: string | number;
  warn_at_percent: number;
  timezone: string;
  status: "active" | "paused";
  client_scope: "all" | "selected";
};

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "paused_budget"
  | "refused";

/** Tokens de uma chamada, já normalizados: input não inclui o que veio do cache. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = { id: string; name: string; content: string; isError: boolean };

/** Fatia do uso cobrada por um modelo (o fallback do servidor pode servir outro modelo). */
export type UsageSlice = { model: string; usage: Usage };
