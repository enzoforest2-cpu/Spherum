import type { SandboxProvider } from "./provider";

/**
 * Preparo da máquina (contrato; a implementação completa substitui este arquivo): usuário xodo
 * sem sudo, tela, navegador, gateway da tela com token e regras de rede.
 */

/** Versão do preparo: quando muda, a máquina é preparada de novo. */
export const RUNTIME_VERSION = "0";

export async function prepareMachine(provider: SandboxProvider, ref: string, opts: { egressMode: "aberto" | "restrito" }): Promise<void> {
  void provider;
  void ref;
  void opts;
}
