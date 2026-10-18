import type { Sql } from "./db";

/**
 * Quem decide se uma ação do xodó roda direto ou espera alguém da equipe.
 *
 * Ordem, da mais forte para a mais fraca:
 *  1. Piso de segurança: o que vai para o cliente sempre pede aprovação, sem exceção.
 *  2. Qualquer regra "exigir aprovação" que case (da agência ou do xodó) vence.
 *  3. Qualquer regra "sempre permitir" que case.
 *  4. O padrão da categoria: leitura e trabalho interno rodam; cliente e campanha perguntam.
 *
 * Diferente do Rakazo, a especificidade não importa: "exigir" sempre vence "permitir",
 * para que uma regra larga da agência nunca seja furada por uma regra estreita de um xodó.
 */

export const CATEGORIES = ["leitura", "rascunho", "memoria", "equipe", "cliente", "campanha"] as const;
export type Category = (typeof CATEGORIES)[number];

const ASK_BY_DEFAULT = new Set<Category>(["cliente", "campanha"]);
const SAFETY_FLOOR = new Set<Category>(["cliente"]);

export type ApprovalRule = {
  effect: "always_allow" | "require_approval";
  match_kind: "tool" | "category";
  match_value: string;
};

export type ApprovalDecision = {
  decision: "allow" | "ask";
  source: "floor" | "require_approval" | "always_allow" | "default";
};

export function decideApproval(input: { toolName: string; category: Category; rules: ApprovalRule[] }): ApprovalDecision {
  if (SAFETY_FLOOR.has(input.category)) return { decision: "ask", source: "floor" };
  const matching = input.rules.filter((rule) =>
    rule.match_kind === "tool" ? rule.match_value === input.toolName : rule.match_value === input.category,
  );
  if (matching.some((rule) => rule.effect === "require_approval")) return { decision: "ask", source: "require_approval" };
  if (matching.some((rule) => rule.effect === "always_allow")) return { decision: "allow", source: "always_allow" };
  return { decision: ASK_BY_DEFAULT.has(input.category) ? "ask" : "allow", source: "default" };
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
