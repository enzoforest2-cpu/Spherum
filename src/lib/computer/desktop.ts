import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { shellQuote, tailText } from "./output";
import type { ProviderId, RunResult, SandboxProvider } from "./provider";

/**
 * Camada portátil da máquina (adaptada do LinuxDesktop e do PREPARE_LINUX_DESKTOP do Rakazo,
 * Apache-2.0): o provedor só roda comandos e lê e grava arquivos; tela, navegador, arquivos e
 * terminal são scripts iguais nos dois provedores. O preparo manda os arquivos da pasta sandbox/
 * do repositório para a máquina e roda o sandbox/prepare.sh como root (idempotente).
 */

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

// ---------------------------------------------------------------------------
// Ajudas comuns aos provedores
// ---------------------------------------------------------------------------

/** Casa do usuário xodo: arquivos daqui são lidos e gravados como xodo, nunca como root. */
export const XODO_HOME_DIR = "/home/xodo";

/**
 * Com que usuário ler ou gravar um caminho. Dentro da casa do xodo é sempre ele (um link
 * plantado ali para um arquivo de root não vaza nada); fora dela, root (arquivos do Spherum).
 */
export function machineUserFor(target: string): "root" | "xodo" {
  const clean = path.posix.normalize(target);
  return clean === XODO_HOME_DIR || clean.startsWith(`${XODO_HOME_DIR}/`) || target.startsWith(`${XODO_HOME_DIR}/`) ? "xodo" : "root";
}

/** Caminho absoluto, sem NUL e sem quebra de linha (vai para APIs de arquivo e para o shell). */
export function assertMachinePath(target: string): string {
  if (typeof target !== "string" || !target.startsWith("/") || /[\0\n\r]/.test(target) || target.length > 4096) {
    throw new Error("caminho inválido na máquina");
  }
  return target;
}

/** Inteiro positivo dentro do limite (números que viram argumento de comando). */
export function assertCount(value: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${what} inválido`);
  return value;
}

// ---------------------------------------------------------------------------
// Preparo
// ---------------------------------------------------------------------------

/** Arquivo da pasta sandbox/ (caminho relativo a ela). */
export type SandboxFile = { path: string; data: Buffer };

/** Pasta sandbox/ do repositório (os testes e o servidor rodam da raiz). */
export const SANDBOX_DIR = process.env.SPHERUM_SANDBOX_DIR?.trim() || path.join(process.cwd(), "sandbox");
/** Onde os arquivos chegam na máquina antes do preparo (o prepare.sh apaga no fim). */
export const PREPARE_DIR = "/opt/spherum/.preparo";
/** O preparo instala pacotes na primeira vez; a função da Vercel corta em 300 s. */
export const PREPARE_TIMEOUT_MS = 240_000;
/** Muda quando este arquivo muda o jeito de chamar o prepare.sh. */
const DRIVER_REVISION = "spherum-preparo-1";

/** Por provedor: o usuário padrão do template (que perde o sudo) e as portas do agente do provedor. */
export const PROVIDER_SETUP: Record<ProviderId, { templateUser: string; allowedPorts: number[] }> = {
  // E2B: o "user" do template tem sudo e vira o xodo; o envd escuta na 49983.
  e2b: { templateUser: "user", allowedPorts: [49983] },
  // Daytona: os comandos chegam pelo usuário do template (com sudo), então ele fica; o daemon usa estas portas.
  daytona: { templateUser: "", allowedPorts: [2280, 22220, 22222] },
  fake: { templateUser: "", allowedPorts: [] },
};

/** Lê prepare.sh, page-browser.py, bin/* e web/* (sem ocultos nem caches), em ordem estável. */
export function loadSandboxFiles(dir: string = SANDBOX_DIR): SandboxFile[] {
  const files: SandboxFile[] = [];
  const add = (rel: string) => files.push({ path: rel, data: readFileSync(path.join(dir, rel)) });
  add("prepare.sh");
  if (isFile(path.join(dir, "page-browser.py"))) add("page-browser.py");
  for (const sub of ["bin", "web"]) {
    const full = path.join(dir, sub);
    if (!isDir(full)) continue;
    for (const name of readdirSync(full).sort()) {
      if (name.startsWith(".") || !/^[A-Za-z0-9._-]+$/.test(name)) continue;
      if (isFile(path.join(full, name))) add(`${sub}/${name}`);
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Hash do conteúdo do preparo: qualquer mudança num arquivo (ou no jeito de chamar) muda a versão. */
export function runtimeVersionOf(files: SandboxFile[]): string {
  const hash = createHash("sha256").update(DRIVER_REVISION).update("\0");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(f.path).update("\0").update(String(f.data.length)).update("\0").update(f.data).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

let loaded: SandboxFile[] | null = null;
function sandboxFiles(): SandboxFile[] {
  loaded ??= loadSandboxFiles();
  return loaded;
}

function computeVersion(): string {
  try {
    return runtimeVersionOf(sandboxFiles());
  } catch {
    // Sem a pasta sandbox/ no pacote: o preparo falha com aviso claro (prepareMachine).
    return "sem-preparo";
  }
}

/** Versão do preparo (hash do conteúdo): quando muda, a máquina é preparada de novo. */
export const RUNTIME_VERSION: string = computeVersion();

/** Comando que roda o prepare.sh na máquina (valores fixos, cada um entre aspas). */
export function prepareCommand(providerId: ProviderId, egressMode: "aberto" | "restrito", version: string = RUNTIME_VERSION): string {
  if (egressMode !== "aberto" && egressMode !== "restrito") throw new Error("modo de rede inválido");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) throw new Error("versão do preparo inválida");
  const setup = PROVIDER_SETUP[providerId];
  if (!setup) throw new Error("provedor desconhecido");
  const ports = setup.allowedPorts.map((p) => String(assertCount(p, 65535, "porta"))).join(" ");
  const env = [
    `SPHERUM_STAGING=${shellQuote(PREPARE_DIR)}`,
    `SPHERUM_EGRESS=${shellQuote(egressMode)}`,
    `SPHERUM_TEMPLATE_USER=${shellQuote(setup.templateUser)}`,
    `SPHERUM_ALLOWED_PORTS=${shellQuote(ports)}`,
    `SPHERUM_RUNTIME_VERSION=${shellQuote(version)}`,
  ];
  return `${env.join(" ")} bash ${PREPARE_DIR}/prepare.sh`;
}

/**
 * Prepara a máquina: manda os arquivos de sandbox/ para PREPARE_DIR (como root) e roda o
 * prepare.sh. O provedor falso não tem máquina de verdade, então nele nada roda.
 */
export async function prepareMachine(provider: SandboxProvider, ref: string, opts: { egressMode: "aberto" | "restrito" }): Promise<void> {
  if (provider.id === "fake") return;
  let files: SandboxFile[];
  try {
    files = sandboxFiles();
  } catch {
    throw new Error("os arquivos do preparo (pasta sandbox/) não estão no servidor");
  }
  const command = prepareCommand(provider.id, opts.egressMode);
  const reset = await provider.run(ref, {
    script: `rm -rf -- ${PREPARE_DIR} && mkdir -p -- ${PREPARE_DIR}/bin ${PREPARE_DIR}/web && chmod 700 ${PREPARE_DIR}`,
    user: "root",
    timeoutMs: 30_000,
  });
  if (reset.code !== 0) throw new Error(`não consegui criar a pasta do preparo (código ${reset.code})`);
  for (const f of files) await provider.write(ref, `${PREPARE_DIR}/${f.path}`, new Uint8Array(f.data));
  const r = await provider.run(ref, { script: command, user: "root", timeoutMs: PREPARE_TIMEOUT_MS });
  if (r.code !== 0) {
    const reason = r.stderr.split("\n").reverse().find((line) => line.includes("ERRO:")) ?? r.stderr;
    throw new Error(`o preparo da máquina falhou (código ${r.code}): ${tailText(reason.trim(), 200)}`);
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
