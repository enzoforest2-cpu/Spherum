/**
 * Provedor de máquinas (adaptado da interface de computador do Rakazo, Apache-2.0). O E2B vem
 * primeiro, o Daytona é a segunda opção e o "fake" serve aos testes. Tudo o que é desktop
 * (tela, navegador, terminal) são scripts iguais nos dois provedores: o provedor só cria,
 * pausa, roda comandos e lê e grava arquivos.
 */

export type ProviderId = "e2b" | "daytona" | "fake";

export type RunResult = { code: number; stdout: string; stderr: string };

export interface SandboxProvider {
  id: ProviderId;
  /** Cria a máquina e devolve o id dela no provedor. */
  create(o: { agencyId: string; computerId: string; generation: number; idleMs: number }): Promise<{ ref: string }>;
  resume(ref: string, idleMs: number): Promise<void>;
  pause(ref: string): Promise<void>;
  destroy(ref: string): Promise<void>;
  /** Adia a pausa por ociosidade (cada atividade chama). */
  extend(ref: string, idleMs: number): Promise<void>;
  run(ref: string, o: { script: string; user: "root" | "xodo"; cwd?: string; stdin?: string; timeoutMs: number }): Promise<RunResult>;
  read(ref: string, path: string, maxBytes: number): Promise<Uint8Array>;
  write(ref: string, path: string, data: Uint8Array | string): Promise<void>;
  /** Endereço público de uma porta da máquina (só a 6100, do gateway com token, fica exposta). */
  publicUrl(ref: string, port: number): Promise<string>;
  /** O erro prova que a máquina sumiu (só então ela é recriada). */
  isGone(error: unknown): boolean;
}

/** Cria o cliente do provedor com a chave da agência (ou do Spherum). */
export type ProviderFactory = (apiKey: string) => SandboxProvider;

export class SandboxGone extends Error {}
