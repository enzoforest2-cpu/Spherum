// Adaptado de packages/adapters/src/daytona-sandbox.ts do Rakazo (Apache-2.0): create com labels, start/stop/delete e isUnrecoverableDaytonaError.
import { randomBytes } from "node:crypto";
import { assertCount, assertMachinePath, machineUserFor } from "../desktop";
import { shellQuote } from "../output";
import { SandboxGone, type ProviderFactory, type RunResult, type SandboxProvider } from "../provider";

/**
 * Máquinas no Daytona (segunda opção). O próprio Daytona para a máquina depois de autoStop
 * minutos sem atividade e arquiva depois de 7 dias parada; nunca apaga sozinho. Parar guarda o
 * disco, não a memória: na volta os serviços da tela sobem de novo (spherum-start).
 *
 * Os comandos chegam pelo usuário do template; root vem por sudo (ou direto, se já for root) e
 * o xodo por setpriv a partir de root. A saída de erro volta separada por um marcador com nonce.
 */

/** Snapshot opcional para as máquinas (sem ele, o padrão do servidor). */
export const DAYTONA_SNAPSHOT = process.env.DAYTONA_COMPUTER_SNAPSHOT?.trim() || undefined;
const ARCHIVE_AFTER_MIN = 10_080;
const PREVIEW_TTL_S = 3_600;
const MAX_READ_BYTES = 100 * 1024 * 1024;
const LIFECYCLE_TIMEOUT_S = 120;
/** Volta da máquina: serviços da tela (a memória não volta no Daytona). */
const RESTART_SERVICES = "[ -x /opt/spherum/bin/spherum-start ] && /opt/spherum/bin/spherum-start || true";

type User = "root" | "xodo";

/** O pedaço de uma máquina do SDK que usamos (os testes injetam uma falsa). */
export interface DaytonaBox {
  id: string;
  state?: string;
  recoverable?: boolean;
  autoStopInterval?: number;
  start(timeoutS: number): Promise<void>;
  stop(timeoutS: number): Promise<void>;
  remove(timeoutS: number): Promise<void>;
  recover(timeoutS: number): Promise<void>;
  refreshActivity(): Promise<void>;
  setAutostopInterval(minutes: number): Promise<void>;
  exec(command: string, timeoutS: number): Promise<{ exitCode: number; result: string }>;
  upload(data: Buffer, path: string): Promise<void>;
  /** URL assinada de uma porta (o token vai na própria URL; a tela abre sem cabeçalho). */
  previewUrl(port: number, ttlS: number): Promise<string>;
}

export type DaytonaCreateParams = {
  snapshot?: string;
  labels: Record<string, string>;
  autoStopInterval: number;
  autoArchiveInterval: number;
  autoDeleteInterval: number;
  public: false;
};

export interface DaytonaClient {
  create(params: DaytonaCreateParams, timeoutS: number): Promise<DaytonaBox>;
  get(id: string): Promise<DaytonaBox>;
}

/** Parâmetros de criação (labels para achar órfãs, parada por ociosidade, nunca apaga sozinho). */
export function daytonaCreateParams(o: { agencyId: string; computerId: string; generation: number; idleMs: number; snapshot?: string }): DaytonaCreateParams {
  return {
    ...(o.snapshot ? { snapshot: o.snapshot } : {}),
    labels: { spherum_agency: o.agencyId, spherum_computer: o.computerId, generation: String(o.generation) },
    autoStopInterval: idleMinutes(o.idleMs),
    autoArchiveInterval: ARCHIVE_AFTER_MIN,
    autoDeleteInterval: -1,
    public: false,
  };
}

const idleMinutes = (idleMs: number) => Math.max(1, Math.ceil(assertCount(idleMs, 24 * 3_600_000, "prazo de ociosidade") / 60_000));

/** 404 da API (máquina que não existe); arquivo ou processo que falta não contam. */
export function isUnrecoverableDaytonaError(error: unknown): boolean {
  if (error instanceof SandboxGone) return true;
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  if (/File|Git|Process|Lsp/.test(name)) return false;
  if (name === "DaytonaNotFoundError") return true;
  return e.status === 404 || e.statusCode === 404 || e.code === 404 || e.code === "NOT_FOUND";
}

const isExecTimeout = (error: unknown) =>
  error instanceof Error && (error.name === "DaytonaProcessExecutionTimeoutError" || error.name === "DaytonaTimeoutError");

/** O SDK de verdade, carregado só quando um provedor real é usado. */
async function realClient(apiKey: string): Promise<DaytonaClient> {
  const { Daytona } = await import("@daytonaio/sdk");
  const daytona = new Daytona({ apiKey });
  type Real = Awaited<ReturnType<typeof daytona.get>>;
  const wrap = (box: Real): DaytonaBox => ({
    id: box.id,
    state: box.state,
    recoverable: box.recoverable,
    autoStopInterval: box.autoStopInterval,
    start: (t) => box.start(t),
    stop: (t) => box.stop(t),
    remove: (t) => box.delete(t),
    recover: (t) => box.recover(t),
    refreshActivity: () => box.refreshActivity(),
    setAutostopInterval: (m) => box.setAutostopInterval(m),
    exec: async (command, t) => {
      const r = await box.process.executeCommand(command, undefined, undefined, t);
      return { exitCode: r.exitCode, result: r.result };
    },
    upload: (data, path) => box.fs.uploadFile(data, path),
    previewUrl: async (port, ttl) => (await box.getSignedPreviewUrl(port, ttl)).url,
  });
  return {
    create: async (params, t) => wrap(await daytona.create(params, { timeout: t })),
    get: async (id) => wrap(await daytona.get(id)),
  };
}

export class DaytonaProvider implements SandboxProvider {
  readonly id = "daytona" as const;
  private readonly boxes = new Map<string, DaytonaBox>();
  private clientPromise: Promise<DaytonaClient> | null;

  constructor(
    private readonly apiKey: string,
    client?: DaytonaClient,
    private readonly snapshot: string | undefined = DAYTONA_SNAPSHOT,
  ) {
    if (!apiKey) throw new Error("chave do Daytona ausente");
    this.clientPromise = client ? Promise.resolve(client) : null;
  }

  private client(): Promise<DaytonaClient> {
    this.clientPromise ??= realClient(this.apiKey);
    return this.clientPromise;
  }

  /** A máquina no Daytona; só um 404 da API prova que ela sumiu. */
  private async box(ref: string, fresh = false): Promise<DaytonaBox> {
    const cached = fresh ? undefined : this.boxes.get(ref);
    if (cached) return cached;
    let box: DaytonaBox;
    try {
      box = await (await this.client()).get(ref);
    } catch (error) {
      this.boxes.delete(ref);
      if (isUnrecoverableDaytonaError(error)) throw new SandboxGone(`máquina ${ref} sumiu no Daytona`);
      throw error;
    }
    if (box.state === "destroyed" || box.state === "destroying") {
      this.boxes.delete(ref);
      throw new SandboxGone(`máquina ${ref} foi apagada no Daytona`);
    }
    this.boxes.set(ref, box);
    return box;
  }

  private async running(ref: string): Promise<DaytonaBox> {
    const box = await this.box(ref);
    if (box.state && box.state !== "started") throw new Error("A máquina está parada.");
    return box;
  }

  async create(o: { agencyId: string; computerId: string; generation: number; idleMs: number }) {
    const box = await (await this.client()).create(daytonaCreateParams({ ...o, snapshot: this.snapshot }), LIFECYCLE_TIMEOUT_S);
    this.boxes.set(box.id, box);
    return { ref: box.id };
  }

  async resume(ref: string, idleMs: number) {
    const box = await this.box(ref, true);
    if (box.state === "error") {
      if (!box.recoverable) throw new Error("A máquina está com erro no Daytona.");
      await box.recover(LIFECYCLE_TIMEOUT_S);
    } else if (box.state !== "started") {
      await box.start(LIFECYCLE_TIMEOUT_S);
    }
    box.state = "started";
    await this.syncIdle(box, idleMs);
    // A memória não volta: tela, VNC, gateway e vigia sobem de novo (falha aqui não perde a máquina).
    await this.exec(box, RESTART_SERVICES, "root", undefined, undefined, 120_000).catch(() => undefined);
  }

  async pause(ref: string) {
    const box = await this.box(ref, true);
    if (box.state === "stopped" || box.state === "archived") return;
    await box.stop(LIFECYCLE_TIMEOUT_S);
    box.state = "stopped";
  }

  async destroy(ref: string) {
    let box: DaytonaBox;
    try {
      box = await this.box(ref, true);
    } catch (error) {
      if (error instanceof SandboxGone) return;
      throw error;
    }
    this.boxes.delete(ref);
    try {
      await box.remove(LIFECYCLE_TIMEOUT_S);
    } catch (error) {
      // Apagar é idempotente: sumir no meio também conta como apagada.
      if (!isUnrecoverableDaytonaError(error)) throw error;
    }
  }

  async extend(ref: string, idleMs: number) {
    const box = await this.running(ref);
    await box.refreshActivity();
    await this.syncIdle(box, idleMs);
  }

  private async syncIdle(box: DaytonaBox, idleMs: number) {
    const minutes = idleMinutes(idleMs);
    if (box.autoStopInterval !== minutes) {
      await box.setAutostopInterval(minutes);
      box.autoStopInterval = minutes;
    }
  }

  async run(ref: string, o: { script: string; user: User; cwd?: string; stdin?: string; timeoutMs: number }): Promise<RunResult> {
    const box = await this.running(ref);
    return this.exec(box, o.script, o.user, o.cwd, o.stdin === undefined ? undefined : Buffer.from(o.stdin, "utf8"), o.timeoutMs);
  }

  /**
   * Roda como root ou xodo. A entrada vai antes num arquivo temporário (aberto pelo shell de
   * fora); a saída de erro vai para outro, que volta em base64 depois de um marcador com nonce.
   */
  private async exec(box: DaytonaBox, script: string, user: User, cwd: string | undefined, stdin: Buffer | undefined, timeoutMs: number): Promise<RunResult> {
    const ms = assertCount(timeoutMs, 600_000, "prazo do comando");
    if (cwd !== undefined) assertMachinePath(cwd);
    const nonce = randomBytes(12).toString("hex");
    // Pasta 0700 por comando: a entrada e a saída de erro (de root, inclusive) não ficam à vista do xodo.
    const dir = `/tmp/spherum-exec-${nonce}`;
    const errFile = `${dir}/err`;
    const inFile = `${dir}/in`;
    const marker = `__SPHERUM_STDERR_${nonce}__`;
    if (stdin) {
      await box.exec(`mkdir -m 700 ${dir}`, 15);
      await box.upload(stdin, inFile);
    }
    const seconds = Math.ceil(ms / 1000);
    const body = cwd ? `cd -- ${shellQuote(cwd)} && ${script}` : script;
    const asUser =
      user === "xodo"
        ? `exec setpriv --reuid=xodo --regid=xodo --init-groups -- bash -c ${shellQuote(body)}`
        : `exec bash -c ${shellQuote(body)}`;
    const wrapper = [
      `umask 077`,
      stdin ? `[ -d ${dir} ] && [ ! -L ${dir} ] && [ -O ${dir} ] || exit 125` : `mkdir -m 700 ${dir} || exit 125`,
      `if [ "$(id -u)" -eq 0 ]; then as_root() { "$@"; }; else as_root() { sudo -n -- "$@"; }; fi`,
      `as_root timeout --kill-after=5 ${seconds} bash -c ${shellQuote(asUser)} <${stdin ? inFile : "/dev/null"} 2>${errFile}`,
      `rc=$?`,
      `printf '\\n%s\\n' ${marker}`,
      `base64 -w0 ${errFile} 2>/dev/null`,
      `rm -rf ${dir}`,
      `exit $rc`,
    ].join("\n");
    let out: { exitCode: number; result: string };
    try {
      out = await box.exec(`bash -c ${shellQuote(wrapper)}`, seconds + 15);
    } catch (error) {
      if (isExecTimeout(error)) return { code: 124, stdout: "", stderr: `o comando passou de ${ms} ms\n` };
      if (isUnrecoverableDaytonaError(error)) {
        // Confere com a API antes de dizer que sumiu (um 404 do processo não basta).
        await this.box(box.id, true);
      }
      throw error;
    }
    return splitOutput(out.exitCode, out.result ?? "", marker);
  }

  async read(ref: string, path: string, maxBytes: number): Promise<Uint8Array> {
    assertMachinePath(path);
    const limit = assertCount(maxBytes, MAX_READ_BYTES, "tamanho máximo");
    const q = shellQuote(path);
    const r = await this.run(ref, {
      script: `[ -f ${q} ] || { echo 'No such file' >&2; exit 2; }; head -c ${limit} -- ${q} | base64 -w0`,
      user: machineUserFor(path),
      timeoutMs: 120_000,
    });
    if (r.code === 2) throw new Error(`No such file: ${path}`);
    if (r.code !== 0) throw new Error(`não consegui ler ${path}`);
    return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
  }

  async write(ref: string, path: string, data: Uint8Array | string): Promise<void> {
    assertMachinePath(path);
    const box = await this.running(ref);
    const q = shellQuote(path);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const r = await this.exec(box, `mkdir -p -- "$(dirname -- ${q})" && cat > ${q}`, machineUserFor(path), undefined, bytes, 120_000);
    if (r.code !== 0) throw new Error(`não consegui gravar ${path}`);
  }

  async publicUrl(ref: string, port: number): Promise<string> {
    assertCount(port, 65535, "porta");
    const box = await this.running(ref);
    return (await box.previewUrl(port, PREVIEW_TTL_S)).replace(/\/+$/, "");
  }

  isGone(error: unknown): boolean {
    return error instanceof SandboxGone;
  }
}

/** Separa a saída do comando da saída de erro (que veio em base64 depois do marcador). */
export function splitOutput(code: number, result: string, marker: string): RunResult {
  let at = result.lastIndexOf(`\n${marker}`);
  let skip = marker.length + 1;
  // Se a API aparar o começo da saída, o marcador abre o texto.
  if (at < 0 && result.startsWith(marker)) {
    at = 0;
    skip = marker.length;
  }
  if (at < 0) return { code, stdout: result, stderr: "" };
  const stdout = result.slice(0, at);
  const stderr = Buffer.from(result.slice(at + skip).trim(), "base64").toString("utf8");
  return { code, stdout, stderr };
}

/** Fábrica para o ciclo de vida: um cliente por chave (da agência ou do Spherum). */
export function daytonaProvider(client?: DaytonaClient): ProviderFactory {
  return (apiKey) => new DaytonaProvider(apiKey, client);
}
