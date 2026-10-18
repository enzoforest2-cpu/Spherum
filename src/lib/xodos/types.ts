export const SPECIES = ["pingo", "bibo", "oki"] as const;
export const PERSONALITIES = ["curioso", "brincalhao", "direto", "zen"] as const;
/** Os três níveis do passo "Limites" do assistente de criação. */
export const AUTONOMY = ["sempre_pergunta", "pergunta_no_que_importa", "age_sozinho"] as const;

export type Personality = (typeof PERSONALITIES)[number];
export type Autonomy = (typeof AUTONOMY)[number];

export type Xodo = {
  id: string;
  agency_id: string;
  name: string;
  species: (typeof SPECIES)[number];
  color: string;
  personality: Personality;
  role: string | null;
  instructions: string;
  autonomy: Autonomy;
  /** Id do provedor no catálogo de modelos, ou "local" / "custom". */
  provider: string;
  model: string;
  credential_id: string | null;
  /** Teto do dia em reais; nulo quando só registramos o gasto. */
  daily_budget_brl: string | number | null;
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

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = { id: string; name: string; content: string; isError: boolean };
