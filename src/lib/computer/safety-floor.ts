import type { Category } from "../xodos/policy";

/**
 * Piso de comandos do terminal (contrato; a implementação completa, portada do safety-floor do
 * OpenMausBot, substitui este arquivo).
 *
 * deny: nunca roda nem vira pedido (nunca-lista). ask: sempre pergunta, em qualquer autonomia
 * (comando ilegível). allow: segue a categoria (e a autonomia do xodó).
 */
export type CommandVerdict = { verdict: "deny" | "ask" | "allow"; category: Category; reason: string | null };

export function classifyCommand(command: string): CommandVerdict {
  void command;
  return { verdict: "ask", category: "alteracao", reason: "classificador ainda não instalado" };
}
