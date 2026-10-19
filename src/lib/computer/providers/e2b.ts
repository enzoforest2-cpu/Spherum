// Adaptado de packages/adapters/src/e2b-sandbox.ts do Rakazo (Apache-2.0): opções do create, retomada por connect e isSandboxGoneError.
import { assertCount, assertMachinePath, machineUserFor } from "../desktop";
import { shellQuote } from "../output";
import { SandboxGone, type ProviderFactory, type RunResult, type SandboxProvider } from "../provider";

/**
 * Máquinas no E2B (microVM; a pausa guarda disco e memória). A pausa por ociosidade é do próprio
 * E2B (onTimeout "pause"), sem retomada automática: abrir a URL de uma máquina pausada não a
 * acorda (nem gera cobrança). Cada atividade adia o prazo com setTimeout. O handle da máquina
 * fica em cache só durante a invocação; a próxima chama connect de novo.
 */

/** Template público de desktop do E2B (dá para trocar por variável de ambiente). */
export const E2B_TEMPLATE = process.env.E2B_COMPUTER_TEMPLATE?.trim() || "desktop";
/** Maior arquivo lido de uma vez (os anexos vão até 25 MB). */
const MAX_READ_BYTES = 100 * 1024 * 1024;
const STDIN_CHUNK = 64 * 1024;

type User = "root" | "xodo";
export type E2BCommandResult = { exitCode: number; stdout: string; stderr: string };
export type E2BCommandHandle = {
  wait(): Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
  sendStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
};

/** O pedaço de uma máquina do SDK que usamos (os testes injetam um falso). */
export interface E2BBox {
  sandboxId: string;
  getHost(port: number): string;
  run(cmd: string, o: { user: User; cwd?: string; timeoutMs: number }): Promise<E2BCommandResult>;
  /** Comando em segundo plano com a entrada aberta (para mandar o stdin e fechar). */
  start(cmd: string, o: { user: User; cwd?: string; timeoutMs: number }): Promise<E2BCommandHandle>;
  read(path: string, user: User): Promise<Uint8Array>;
  write(path: string, data: string | ArrayBuffer, user: User): Promise<void>;
  size(path: string, user: User): Promise<number>;
}

export type E2BCreateOptions = {
  apiKey: string;
  timeoutMs: number;
  metadata: Record<string, string>;
  lifecycle: { onTimeout: "pause"; autoResume: false };
};

/** O pedaço do SDK que usamos. */
export interface E2BSdk {
  create(template: string, o: E2BCreateOptions): Promise<E2BBox>;
  connect(id: string, o: { apiKey: string; timeoutMs?: number }): Promise<E2BBox>;
  setTimeout(id: string, timeoutMs: number, o: { apiKey: string }): Promise<void>;
  pause(id: string, o: { apiKey: string }): Promise<boolean>;
  kill(id: string, o: { apiKey: string }): Promise<boolean>;
  getInfo(id: string, o: { apiKey: string }): Promise<{ state: "running" | "paused" }>;
}

/** Opções de criação (pausa no prazo, sem retomada automática, metadata para achar órfãs). */
export function e2bCreateOptions(o: { apiKey: string; agencyId: string; computerId: string; generation: number; idleMs: number }): E2BCreateOptions {
  return {
    apiKey: o.apiKey,
    timeoutMs: o.idleMs,
    metadata: { spherum_agency: o.agencyId, spherum_computer: o.computerId, generation: String(o.generation) },
    lifecycle: { onTimeout: "pause", autoResume: false },
  };
}

// Como o SDK do E2B diz que a máquina não existe (nem sempre com "not found"; regex do Rakazo).
const SANDBOX_GONE_MESSAGE =
  /probably not running anymore|likely due to sandbox timeout|killed or reached its end of life|sandbox [^:]{0,60}not found|sandbox [^:]{0,60}does not exist/i;
// As mesmas palavras vindas de dentro de uma máquina viva: binário ou arquivo que falta.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;

/** Só evidência do provedor de que a máquina sumiu permite recriar. */
export function isSandboxGoneError(error: unknown): boolean {
  if (error instanceof SandboxGone) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (SHELL_MISSING_TARGET.test(message)) return false;
  if (SANDBOX_GONE_MESSAGE.test(message)) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxNotFoundError") return true;
  }
  return false;
}

const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

/** Erro de saída diferente de zero (CommandExitError) traz o resultado junto. */
function exitResult(error: unknown): E2BCommandResult | null {
  const e = error as Partial<E2BCommandResult> | null;
  if (e && typeof e === "object" && typeof e.exitCode === "number" && typeof e.stdout === "string" && typeof e.stderr === "string") {
    return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr };
  }
  return null;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** O SDK de verdade, carregado só quando um provedor real é usado (os testes injetam outro). */
async function realSdk(): Promise<E2BSdk> {
  const { Sandbox } = await import("e2b");
  type Real = InstanceType<typeof Sandbox>;
  const wrap = (box: Real): E2BBox => ({
    sandboxId: box.sandboxId,
    getHost: (port) => box.getHost(port),
    run: (cmd, o) => box.commands.run(cmd, { user: o.user, cwd: o.cwd, timeoutMs: o.timeoutMs }),
    start: async (cmd, o) => {
      const handle = await box.commands.run(cmd, { user: o.user, cwd: o.cwd, timeoutMs: o.timeoutMs, background: true, stdin: true });
      return {
        wait: () => handle.wait(),
        kill: () => handle.kill(),
        sendStdin: (data) => handle.sendStdin(data),
        closeStdin: () => handle.closeStdin(),
      };
    },
    read: (path, user) => box.files.read(path, { format: "bytes", user }),
    write: async (path, data, user) => {
      await box.files.write(path, data, { user });
    },
    size: async (path, user) => (await box.files.getInfo(path, { user })).size,
  });
  return {
    create: async (template, o) => wrap(await Sandbox.create(template, o)),
    connect: async (id, o) => wrap(await Sandbox.connect(id, o)),
    setTimeout: (id, ms, o) => Sandbox.setTimeout(id, ms, o),
    pause: (id, o) => Sandbox.pause(id, o),
    kill: (id, o) => Sandbox.kill(id, o),
    getInfo: async (id, o) => ({ state: (await Sandbox.getInfo(id, o)).state }),
  };
}

export class E2BProvider implements SandboxProvider {
  readonly id = "e2b" as const;
  private readonly boxes = new Map<string, Promise<E2BBox>>();
  private sdkPromise: Promise<E2BSdk> | null;

  constructor(
    private readonly apiKey: string,
    sdk?: E2BSdk,
    private readonly template: string = E2B_TEMPLATE,
  ) {
    if (!apiKey) throw new Error("chave do E2B ausente");
    this.sdkPromise = sdk ? Promise.resolve(sdk) : null;
  }

  private sdk(): Promise<E2BSdk> {
    this.sdkPromise ??= realSdk();
    return this.sdkPromise;
  }

  private get auth() {
    return { apiKey: this.apiKey };
  }

  /**
   * Um erro com cara de "a máquina sumiu" só vale com prova: o E2B não acha a máquina nem
   * pausada. Pausada (o prazo venceu no meio), é um erro comum e a máquina continua lá.
   */
  private async classify(ref: string, error: unknown): Promise<never> {
    if (error instanceof SandboxGone) throw error;
    if (!isSandboxGoneError(error)) throw error;
    this.boxes.delete(ref);
    let state: string | null = null;
    try {
      state = (await (await this.sdk()).getInfo(ref, this.auth)).state;
    } catch (infoError) {
      if (isSandboxGoneError(infoError)) throw new SandboxGone(`máquina ${ref} sumiu no E2B`);
      throw infoError;
    }
    throw new Error(state === "paused" ? "A máquina pausou no meio da operação." : "A máquina não respondeu.");
  }

  /** Handle da máquina (connect também retoma uma pausada). */
  private box(ref: string, timeoutMs?: number): Promise<E2BBox> {
    const cached = this.boxes.get(ref);
    if (cached) return cached;
    const pending = (async () => {
      try {
        return await (await this.sdk()).connect(ref, { ...this.auth, ...(timeoutMs ? { timeoutMs } : {}) });
      } catch (error) {
        return this.classify(ref, error);
      }
    })();
    this.boxes.set(ref, pending);
    pending.catch(() => {
      if (this.boxes.get(ref) === pending) this.boxes.delete(ref);
    });
    return pending;
  }

  async create(o: { agencyId: string; computerId: string; generation: number; idleMs: number }) {
    assertCount(o.idleMs, 24 * 3_600_000, "prazo de ociosidade");
    const box = await (await this.sdk()).create(this.template, e2bCreateOptions({ apiKey: this.apiKey, ...o }));
    this.boxes.set(box.sandboxId, Promise.resolve(box));
    return { ref: box.sandboxId };
  }

  async resume(ref: string, idleMs: number) {
    assertCount(idleMs, 24 * 3_600_000, "prazo de ociosidade");
    this.boxes.delete(ref);
    await this.box(ref, idleMs);
  }

  async pause(ref: string) {
    this.boxes.delete(ref);
    try {
      await (await this.sdk()).pause(ref, this.auth);
    } catch (error) {
      await this.classify(ref, error);
    }
  }

  async destroy(ref: string) {
    this.boxes.delete(ref);
    // kill devolve false quando a máquina já não existe: o desligamento está completo.
    await (await this.sdk()).kill(ref, this.auth);
  }

  async extend(ref: string, idleMs: number) {
    assertCount(idleMs, 24 * 3_600_000, "prazo de ociosidade");
    try {
      await (await this.sdk()).setTimeout(ref, idleMs, this.auth);
    } catch (error) {
      if (!isSandboxGoneError(error)) throw error;
      // O E2B pode ter pausado um pouco antes do prazo do banco: confere e retoma.
      let state: string;
      try {
        state = (await (await this.sdk()).getInfo(ref, this.auth)).state;
      } catch (infoError) {
        if (isSandboxGoneError(infoError)) throw new SandboxGone(`máquina ${ref} sumiu no E2B`);
        throw infoError;
      }
      if (state === "paused") await this.resume(ref, idleMs);
      else throw error instanceof Error ? new Error(`não consegui adiar a pausa: ${error.message}`) : error;
    }
  }

  async run(ref: string, o: { script: string; user: User; cwd?: string; stdin?: string; timeoutMs: number }): Promise<RunResult> {
    const timeoutMs = assertCount(o.timeoutMs, 600_000, "prazo do comando");
    if (o.cwd !== undefined) assertMachinePath(o.cwd);
    const box = await this.box(ref);
    // O shell de login de fora do E2B pode falhar no logout sob set -e: o script vai num bash próprio.
    const cmd = `bash -c ${shellQuote(o.script)}`;
    const opts = { user: o.user, cwd: o.cwd, timeoutMs };
    try {
      if (o.stdin === undefined) {
        const r = await box.run(cmd, opts);
        return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      }
      const handle = await box.start(cmd, opts);
      try {
        for (let i = 0; i < o.stdin.length; i += STDIN_CHUNK) await handle.sendStdin(o.stdin.slice(i, i + STDIN_CHUNK));
        await handle.closeStdin();
      } catch (error) {
        await handle.kill().catch(() => false);
        throw error;
      }
      try {
        const r = await handle.wait();
        return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      } catch (error) {
        if (isTimeout(error)) await handle.kill().catch(() => false);
        throw error;
      }
    } catch (error) {
      const exited = exitResult(error);
      if (exited) return { code: exited.exitCode, stdout: exited.stdout, stderr: exited.stderr };
      if (isTimeout(error)) return { code: 124, stdout: "", stderr: `o comando passou de ${timeoutMs} ms\n` };
      return this.classify(ref, error);
    }
  }

  async read(ref: string, path: string, maxBytes: number): Promise<Uint8Array> {
    assertMachinePath(path);
    const limit = assertCount(maxBytes, MAX_READ_BYTES, "tamanho máximo");
    const user = machineUserFor(path);
    const box = await this.box(ref);
    try {
      if ((await box.size(path, user)) <= limit) return await box.read(path, user);
    } catch (error) {
      return this.classify(ref, error);
    }
    // Maior que o limite: só o começo (quem chama decide o que fazer com o excesso).
    const r = await this.run(ref, { script: `head -c ${limit} -- ${shellQuote(path)} | base64 -w0`, user, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`não consegui ler ${path}`);
    return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
  }

  async write(ref: string, path: string, data: Uint8Array | string): Promise<void> {
    assertMachinePath(path);
    const box = await this.box(ref);
    try {
      await box.write(path, typeof data === "string" ? data : toArrayBuffer(data), machineUserFor(path));
    } catch (error) {
      await this.classify(ref, error);
    }
  }

  async publicUrl(ref: string, port: number): Promise<string> {
    assertCount(port, 65535, "porta");
    const box = await this.box(ref);
    return `https://${box.getHost(port)}`;
  }

  isGone(error: unknown): boolean {
    return isSandboxGoneError(error);
  }
}

/** Fábrica para o ciclo de vida: um cliente por chave (da agência ou do Spherum). */
export function e2bProvider(sdk?: E2BSdk): ProviderFactory {
  return (apiKey) => new E2BProvider(apiKey, sdk);
}
