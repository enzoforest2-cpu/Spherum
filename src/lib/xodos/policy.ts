import type { Sql } from "./db";
import type { Autonomy } from "./types";

/**
 * Quem decide se uma ação do xodó roda direto ou espera alguém da equipe.
 *
 * Ordem, da mais forte para a mais fraca:
 *  1. Piso de segurança: o que vai para o cliente sempre pede aprovação, sem exceção.
 *  2. Qualquer regra "exigir aprovação" que case (da agência ou do xodó) vence.
 *  3. Teto do gatilho: numa execução disparada por evento, o que a autonomia do gatilho manda
 *     perguntar pergunta, mesmo com "sempre permitir" (o conteúdo veio de fora).
 *  4. Qualquer regra "sempre permitir" que case.
 *  5. A autonomia escolhida na criação do xodó (passo "Limites" do design):
 *     - "Sempre pergunta": tudo que muda alguma coisa pergunta; só leitura roda direto.
 *     - "Pergunta no que importa": pergunta antes de enviar, pagar ou apagar (envio, pagamento,
 *       exclusão, cliente e campanha); criar e editar em apps roda direto.
 *     - "Age sozinho": faz e conta depois. O piso do item 1 continua valendo.
 *
 * Diferente do Rakazo, a especificidade não importa: "exigir" sempre vence "permitir",
 * para que uma regra larga da agência nunca seja furada por uma regra estreita de um xodó.
 */

/**
 * leitura: só consulta. rascunho, memoria, equipe: trabalho interno do Spherum.
 * alteracao: cria ou edita algo num app (evento na agenda, página no Notion).
 * envio: chega a alguém de fora (e-mail, mensagem, post). exclusao: apaga ou arquiva.
 * pagamento: move dinheiro. campanha: mexe em anúncios e verba. cliente: vai para o portal do cliente.
 */
export const CATEGORIES = [
  "leitura",
  "rascunho",
  "memoria",
  "equipe",
  "alteracao",
  "envio",
  "exclusao",
  "pagamento",
  "campanha",
  "cliente",
] as const;
export type Category = (typeof CATEGORIES)[number];

const ASK_BY_AUTONOMY: Record<Autonomy, Set<Category>> = {
  sempre_pergunta: new Set(CATEGORIES.filter((c) => c !== "leitura")),
  pergunta_no_que_importa: new Set(["envio", "exclusao", "pagamento", "campanha", "cliente"]),
  age_sozinho: new Set(),
};
const SAFETY_FLOOR = new Set<Category>(["cliente"]);

export type ApprovalRule = {
  effect: "always_allow" | "require_approval";
  match_kind: "tool" | "category";
  match_value: string;
};

export type ApprovalDecision = {
  decision: "allow" | "ask";
  source: "floor" | "require_approval" | "cap" | "always_allow" | "autonomy";
};

export function decideApproval(input: {
  toolName: string;
  category: Category;
  rules: ApprovalRule[];
  autonomy: Autonomy;
  /** Autonomia máxima de uma execução por gatilho; nulo nas outras. */
  cap?: Autonomy | null;
}): ApprovalDecision {
  if (SAFETY_FLOOR.has(input.category)) return { decision: "ask", source: "floor" };
  const matching = input.rules.filter((rule) =>
    rule.match_kind === "tool" ? rule.match_value === input.toolName : rule.match_value === input.category,
  );
  if (matching.some((rule) => rule.effect === "require_approval")) return { decision: "ask", source: "require_approval" };
  if (input.cap && ASK_BY_AUTONOMY[input.cap].has(input.category)) return { decision: "ask", source: "cap" };
  if (matching.some((rule) => rule.effect === "always_allow")) return { decision: "allow", source: "always_allow" };
  return { decision: ASK_BY_AUTONOMY[input.autonomy].has(input.category) ? "ask" : "allow", source: "autonomy" };
}

/** "Aprovar sempre" não vale para o piso de segurança: vira aprovação de uma vez só. */
export function canAlwaysAllow(category: Category): boolean {
  return !SAFETY_FLOOR.has(category);
}

export async function loadRules(sql: Sql, agencyId: string, xodoId: string): Promise<ApprovalRule[]> {
  return sql.query<ApprovalRule>(
    `select effect, match_kind, match_value from approval_rules
      where agency_id = $1 and (xodo_id is null or xodo_id = $2)`,
    [agencyId, xodoId],
  );
}
