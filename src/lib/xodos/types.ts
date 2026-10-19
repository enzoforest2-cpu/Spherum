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
  /** Modelo das rotinas agendadas; nulo usa o principal. */
  routine_provider: string | null;
  routine_model: string | null;
  routine_credential_id: string | null;
  /** Teto do dia em reais; nulo quando só registramos o gasto. */
  daily_budget_brl: string | number | null;
  warn_at_percent: number;
  /** Maior mudança de verba (em %) que o xodó faz sem perguntar; acima disso, sempre pede aprovação. */
  campaign_max_change_pct: number;
  /** Maior verba diária (R$) que o xodó define sem perguntar; nulo: sem teto absoluto. */
  campaign_max_daily_brl: string | number | null;
  timezone: string;
  status: "active" | "paused";
  client_scope: "all" | "selected";
  /** Memória ligada (bloco no prompt e ferramentas de memória). */
  memory_enabled: boolean;
  /** Captura automática depois das conversas do app (e dos canais, se memory_capture_channels). */
  memory_capture: boolean;
  memory_capture_channels: boolean;
  /** Arrumação noturna com o modelo (organizar e resolver contradições). */
  memory_tidy: boolean;
  /** Tamanho do núcleo no prompt, em caracteres. */
  memory_core_chars: number | string;
  memory_tidied_on: string | null;
  memory_topic_cursor: string | null;
  memory_upkeep_until: Date | string | null;
  /** Computador na nuvem: off, cloud (local fica reservado para "Este computador"). */
  computer_mode: "off" | "cloud" | "local";
  computer_browser: boolean;
  computer_files: boolean;
  computer_terminal: boolean;
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
