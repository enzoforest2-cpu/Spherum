import { shellQuote } from "./output";
import type { RunResult, SandboxProvider } from "./provider";

/**
 * Camada portátil da máquina (adaptada do LinuxDesktop do Rakazo, Apache-2.0): o provedor só
 * roda comandos e lê e grava arquivos; tela, navegador, arquivos e terminal são scripts iguais
 * nos dois provedores. O preparo completo (usuário sem sudo, tela, navegador, gateway da tela e
 * rede) substitui o contrato de prepareMachine abaixo.
 */

/** Versão do preparo: quando muda, a máquina é preparada de novo. */
export const RUNTIME_VERSION = "0";

/** Pastas do xodó na máquina (tudo o que as ferramentas de arquivo enxergam fica aqui). */
export const HOME = "/home/xodo/spherum";
export const FOLDERS = {
  agencia: `${HOME}/agencia`,
  clientes: `${HOME}/clientes`,
  xodos: `${HOME}/xodos`,
  downloads: `${HOME}/downloads`,
  lixeira: `${HOME}/.lixeira`,
} as const;

/** Ambiente limpo dos comandos do xodó: nenhuma credencial, só o básico (ideia do OpenMausBot). */
export const XODO_ENV = "env -i HOME=/home/xodo PATH=/usr/local/bin:/usr/bin:/bin LANG=pt_BR.UTF-8 TZ=America/Sao_Paulo DISPLAY=:20";

/** Roda um script como o usuário xodo (sem sudo), no ambiente limpo, a partir da pasta dele. */
export function runAsXodo(
  provider: SandboxProvider,
  ref: string,
  script: string,
  opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {},
): Promise<RunResult> {
  return provider.run(ref, {
    // Aspas simples escapadas: o script chega inteiro ao bash, sem expansão de $ ou crases no caminho.
    script: `${XODO_ENV} bash -lc ${shellQuote(script)}`,
    user: "xodo",
    cwd: opts.cwd ?? HOME,
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
}

export async function prepareMachine(provider: SandboxProvider, ref: string, opts: { egressMode: "aberto" | "restrito" }): Promise<void> {
  void provider;
  void ref;
  void opts;
}
