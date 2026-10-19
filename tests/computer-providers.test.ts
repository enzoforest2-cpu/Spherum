import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadSandboxFiles,
  machineUserFor,
  PREPARE_DIR,
  prepareCommand,
  prepareMachine,
  RUNTIME_VERSION,
  runtimeVersionOf,
  SANDBOX_DIR,
} from "../src/lib/computer/desktop";
import { SandboxGone, type SandboxProvider } from "../src/lib/computer/provider";
import { DaytonaProvider, daytonaProvider, splitOutput, type DaytonaBox, type DaytonaClient, type DaytonaCreateParams } from "../src/lib/computer/providers/daytona";
import {
  E2BProvider,
  e2bProvider,
  isSandboxGoneError,
  type E2BBox,
  type E2BCommandResult,
  type E2BCreateOptions,
  type E2BSdk,
} from "../src/lib/computer/providers/e2b";
import { fakeProvider, fakeWorld } from "../src/lib/computer/providers/fake";

const HAS_BASH = spawnSync("bash", ["-c", "true"]).status === 0;
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

// ---------------------------------------------------------------------------
// E2B com SDK falso
// ---------------------------------------------------------------------------

type Call = { op: string; args: unknown[] };

class FakeE2B implements E2BSdk {
  calls: Call[] = [];
  boxes = new Map<string, { state: "running" | "paused" | "gone"; files: Map<string, Uint8Array> }>();
  onRun: (cmd: string, o: { user: string; cwd?: string; timeoutMs: number; stdin?: string }) => Promise<E2BCommandResult> = async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  setTimeoutError: Error | null = null;
  next = 1;

  private box(id: string): E2BBox {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- os métodos do objeto devolvido têm o próprio this
    const fake = this;
    return {
      sandboxId: id,
      getHost: (port) => `${port}-${id}.e2b.app`,
      async run(cmd, o) {
        fake.calls.push({ op: "run", args: [cmd, o] });
        return fake.onRun(cmd, o);
      },
      async start(cmd, o) {
        let stdin = "";
        const chunks: string[] = [];
        fake.calls.push({ op: "start", args: [cmd, o, chunks] });
        return {
          sendStdin: async (data) => {
            chunks.push(data);
            stdin += data;
          },
          closeStdin: async () => {
            fake.calls.push({ op: "closeStdin", args: [] });
          },
          wait: () => fake.onRun(cmd, { ...o, stdin }),
          kill: async () => {
            fake.calls.push({ op: "killCommand", args: [] });
            return true;
          },
        };
      },
      async read(p, user) {
        fake.calls.push({ op: "read", args: [p, user] });
        const data = fake.boxes.get(id)!.files.get(p);
        if (!data) throw named("FileNotFoundError", `Path ${p} not found`);
        return data;
      },
      async write(p, data, user) {
        fake.calls.push({ op: "write", args: [p, data, user] });
        fake.boxes.get(id)!.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
      },
      async size(p, user) {
        fake.calls.push({ op: "size", args: [p, user] });
        const data = fake.boxes.get(id)!.files.get(p);
        if (!data) throw named("FileNotFoundError", `Path ${p} not found`);
        return data.length;
      },
    };
  }

  async create(template: string, o: E2BCreateOptions) {
    const id = `sbx${this.next++}`;
    this.boxes.set(id, { state: "running", files: new Map() });
    this.calls.push({ op: "create", args: [template, o] });
    return this.box(id);
  }
  async connect(id: string, o: { apiKey: string; timeoutMs?: number }) {
    this.calls.push({ op: "connect", args: [id, o] });
    const b = this.boxes.get(id);
    if (!b || b.state === "gone") throw named("SandboxNotFoundError", `Sandbox ${id} not found`);
    b.state = "running";
    return this.box(id);
  }
  async setTimeout(id: string, ms: number, o: { apiKey: string }) {
    this.calls.push({ op: "setTimeout", args: [id, ms, o] });
    if (this.setTimeoutError) throw this.setTimeoutError;
    const b = this.boxes.get(id);
    if (!b || b.state === "gone") throw named("SandboxNotFoundError", `Sandbox ${id} not found`);
  }
  async pause(id: string, o: { apiKey: string }) {
    this.calls.push({ op: "pause", args: [id, o] });
    const b = this.boxes.get(id);
    if (!b || b.state === "gone") throw named("SandboxNotFoundError", `Sandbox ${id} not found`);
    const was = b.state === "running";
    b.state = "paused";
    return was;
  }
  async kill(id: string, o: { apiKey: string }) {
    this.calls.push({ op: "kill", args: [id, o] });
    const b = this.boxes.get(id);
    if (!b || b.state === "gone") return false;
    b.state = "gone";
    return true;
  }
  async getInfo(id: string, o: { apiKey: string }) {
    this.calls.push({ op: "getInfo", args: [id, o] });
    const b = this.boxes.get(id);
    if (!b || b.state === "gone") throw named("SandboxNotFoundError", `Sandbox ${id} not found`);
    return { state: b.state };
  }
  ops = () => this.calls.map((c) => c.op);
}

const createInput = { agencyId: "ag-1", computerId: "pc-1", generation: 3, idleMs: 600_000 };

test("E2B: cria pausando no prazo, sem retomar sozinho, com metadata para achar órfãs", async () => {
  const sdk = new FakeE2B();
  const p = e2bProvider(sdk)("e2b_chave");
  assert.equal(p.id, "e2b");
  const { ref } = await p.create(createInput);
  const [template, opts] = sdk.calls[0].args as [string, E2BCreateOptions];
  assert.equal(template, "desktop");
  assert.deepEqual(opts, {
    apiKey: "e2b_chave",
    timeoutMs: 600_000,
    metadata: { spherum_agency: "ag-1", spherum_computer: "pc-1", generation: "3" },
    lifecycle: { onTimeout: "pause", autoResume: false },
  });
  assert.equal(ref, "sbx1");
  assert.throws(() => e2bProvider(sdk)(""), /chave do E2B/);
});

test("E2B: retoma com connect, estende com setTimeout, pausa e destrói (idempotente)", async () => {
  const sdk = new FakeE2B();
  const p = new E2BProvider("k", sdk);
  const { ref } = await p.create(createInput);
  await p.pause(ref);
  assert.equal(sdk.boxes.get(ref)!.state, "paused");
  await p.resume(ref, 300_000);
  assert.deepEqual(sdk.calls.find((c) => c.op === "connect")!.args, [ref, { apiKey: "k", timeoutMs: 300_000 }]);
  assert.equal(sdk.boxes.get(ref)!.state, "running");
  await p.extend(ref, 300_000);
  assert.deepEqual(sdk.calls.at(-1)!.args, [ref, 300_000, { apiKey: "k" }]);
  await p.destroy(ref);
  await p.destroy(ref);
  assert.deepEqual(sdk.ops().filter((o) => o === "kill"), ["kill", "kill"], "matar de novo não dá erro");
  await assert.rejects(p.pause(ref), (e) => p.isGone(e));
  await assert.rejects(p.extend(ref, 1000), (e) => p.isGone(e));
  for (const bad of [0, -1, 1.5, Number.NaN]) await assert.rejects(p.extend(ref, bad), /inválido/);
});

test("E2B: estender uma máquina que o E2B pausou antes do prazo retoma em vez de recriar", async () => {
  const sdk = new FakeE2B();
  const p = new E2BProvider("k", sdk);
  const { ref } = await p.create(createInput);
  sdk.boxes.get(ref)!.state = "paused";
  sdk.setTimeoutError = new Error(`Sandbox ${ref} not found`);
  await p.extend(ref, 600_000);
  assert.deepEqual(sdk.ops().slice(-3), ["setTimeout", "getInfo", "connect"]);
  assert.equal(sdk.boxes.get(ref)!.state, "running");
  // Sumiu de verdade: só aí é "gone".
  sdk.boxes.get(ref)!.state = "gone";
  await assert.rejects(p.extend(ref, 600_000), (e) => e instanceof SandboxGone && p.isGone(e));
});

test("E2B: run com usuário, pasta e prazo; código de saída, prazo estourado e entrada padrão em pedaços", async () => {
  const sdk = new FakeE2B();
  const p = new E2BProvider("k", sdk);
  const { ref } = await p.create(createInput);
  sdk.onRun = async (cmd, o) => ({ exitCode: 0, stdout: `[${o.user}] ${cmd}`, stderr: "" });
  const ok = await p.run(ref, { script: "echo 'oi' $HOME", user: "xodo", cwd: "/home/xodo/spherum", timeoutMs: 30_000 });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, `[xodo] bash -c 'echo '\\''oi'\\'' $HOME'`, "o script vai inteiro entre aspas simples");
  assert.deepEqual(sdk.calls.at(-1)!.args[1], { user: "xodo", cwd: "/home/xodo/spherum", timeoutMs: 30_000 });

  // CommandExitError traz o resultado: vira código, não exceção.
  sdk.onRun = async () => {
    throw Object.assign(new Error("exit status 3"), { name: "CommandExitError", exitCode: 3, stdout: "parcial", stderr: "falhou" });
  };
  assert.deepEqual(await p.run(ref, { script: "false", user: "root", timeoutMs: 1000 }), { code: 3, stdout: "parcial", stderr: "falhou" });

  sdk.onRun = async () => {
    throw named("TimeoutError", "context deadline exceeded");
  };
  const slow = await p.run(ref, { script: "sleep 99", user: "xodo", timeoutMs: 2000 });
  assert.equal(slow.code, 124);

  const big = "A".repeat(150 * 1024);
  sdk.onRun = async (_cmd, o) => ({ exitCode: 0, stdout: String(o.stdin?.length), stderr: "" });
  const piped = await p.run(ref, { script: "base64 -d > f", user: "xodo", stdin: big, timeoutMs: 30_000 });
  assert.equal(piped.stdout, String(big.length));
  const chunks = sdk.calls.find((c) => c.op === "start")!.args[2] as string[];
  assert.equal(chunks.length, 3, "pedaços de 64 KiB");
  assert.ok(sdk.ops().includes("closeStdin"), "fecha a entrada para o comando terminar");

  for (const bad of [0, 600_001, 2.5]) await assert.rejects(p.run(ref, { script: "true", user: "root", timeoutMs: bad }), /inválido/);
  await assert.rejects(p.run(ref, { script: "true", user: "root", cwd: "relativo", timeoutMs: 1000 }), /caminho inválido/);
});

test("E2B: 'não está mais rodando' no meio do comando só vira 'sumiu' com prova do provedor", async () => {
  const sdk = new FakeE2B();
  const p = new E2BProvider("k", sdk);
  const { ref } = await p.create(createInput);
  sdk.onRun = async () => {
    throw new Error("The sandbox is probably not running anymore");
  };
  sdk.boxes.get(ref)!.state = "paused";
  const paused = await p.run(ref, { script: "true", user: "root", timeoutMs: 1000 }).catch((e: unknown) => e);
  assert.ok(paused instanceof Error && /pausou/.test(paused.message));
  assert.equal(p.isGone(paused), false, "pausada continua lá: nada de recriar");
  sdk.boxes.get(ref)!.state = "gone";
  const gone = await p.run(ref, { script: "true", user: "root", timeoutMs: 1000 }).catch((e: unknown) => e);
  assert.equal(p.isGone(gone), true);
});

test("E2B: isSandboxGoneError usa as palavras do provedor, não as de dentro da máquina", () => {
  assert.equal(isSandboxGoneError(new Error("Sandbox sbx1 not found")), true);
  assert.equal(isSandboxGoneError(new Error("sandbox was killed or reached its end of life")), true);
  assert.equal(isSandboxGoneError(new Error("bash: foo: command not found")), false);
  assert.equal(isSandboxGoneError(new Error("cat: x: No such file or directory")), false);
  assert.equal(isSandboxGoneError(new Error("path /x not found")), false);
  assert.equal(isSandboxGoneError(new Error("falhou", { cause: named("SandboxNotFoundError", "x") })), true);
  assert.equal(isSandboxGoneError(new SandboxGone("x")), true);
  assert.equal(isSandboxGoneError(new Error("rede caiu")), false);
});

test("E2B: arquivos da casa do xodo como xodo; o resto como root; leitura grande só pelo começo", async () => {
  const sdk = new FakeE2B();
  const p = new E2BProvider("k", sdk);
  const { ref } = await p.create(createInput);
  await p.write(ref, "/home/xodo/spherum/agencia/a.txt", new Uint8Array([1, 2, 3]));
  await p.write(ref, "/opt/spherum/.preparo/prepare.sh", "#!/bin/sh");
  const writes = sdk.calls.filter((c) => c.op === "write").map((c) => [c.args[0], c.args[2], c.args[1] instanceof ArrayBuffer || typeof c.args[1]]);
  assert.deepEqual(writes, [
    ["/home/xodo/spherum/agencia/a.txt", "xodo", true],
    ["/opt/spherum/.preparo/prepare.sh", "root", "string"],
  ]);
  assert.deepEqual([...(await p.read(ref, "/home/xodo/spherum/agencia/a.txt", 10))], [1, 2, 3]);
  assert.equal(sdk.calls.find((c) => c.op === "read")!.args[1], "xodo");
  // Um link plantado na casa do xodo para um arquivo de root é lido como xodo (e falha).
  assert.equal(machineUserFor("/home/xodo/spherum/../../../run/spherum/tokens/control"), "xodo");
  assert.equal(machineUserFor("/run/spherum/tokens/control"), "root");

  sdk.onRun = async (cmd, o) => ({ exitCode: 0, stdout: Buffer.from("AB").toString("base64"), stderr: `${o.user}:${cmd}` });
  const head = await p.read(ref, "/home/xodo/spherum/agencia/a.txt", 2);
  assert.equal(Buffer.from(head).toString(), "AB");
  const cmd = sdk.calls.filter((c) => c.op === "run").at(-1)!.args[0] as string;
  assert.match(cmd, /head -c 2 -- /);
  await assert.rejects(p.read(ref, "/x", 0), /inválido/);
  await assert.rejects(p.read(ref, "/home/xodo/nao-existe", 10), /not found/);
  assert.equal(await p.publicUrl(ref, 6100), `https://6100-${ref}.e2b.app`);
  await assert.rejects(p.publicUrl(ref, 70_000), /inválido/);
});

// ---------------------------------------------------------------------------
// Daytona com cliente falso (os comandos rodam de verdade no bash local, com sudo e setpriv de mentira)
// ---------------------------------------------------------------------------

function shims(): { dir: string; log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "spherum-shim-"));
  const log = path.join(dir, "log");
  writeFileSync(path.join(dir, "sudo"), `#!/bin/sh\necho "sudo $*" >> ${log}\n[ "$1" = -n ] && shift\n[ "$1" = -- ] && shift\nexec "$@"\n`);
  writeFileSync(
    path.join(dir, "setpriv"),
    `#!/bin/sh\necho "setpriv $*" >> ${log}\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
  );
  chmodSync(path.join(dir, "sudo"), 0o755);
  chmodSync(path.join(dir, "setpriv"), 0o755);
  writeFileSync(log, "");
  return { dir, log };
}

class FakeDaytona implements DaytonaClient {
  calls: Call[] = [];
  boxes = new Map<string, DaytonaBox>();
  getError: Error | null = null;
  constructor(private shim: { dir: string; log: string }) {}

  private make(id: string, state: string): DaytonaBox {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- os métodos do objeto devolvido têm o próprio this
    const fake = this;
    const shim = this.shim;
    const box: DaytonaBox = {
      id,
      state,
      recoverable: true,
      autoStopInterval: 10,
      async start(t) {
        fake.calls.push({ op: "start", args: [id, t] });
        box.state = "started";
      },
      async stop(t) {
        fake.calls.push({ op: "stop", args: [id, t] });
        box.state = "stopped";
      },
      async remove(t) {
        fake.calls.push({ op: "remove", args: [id, t] });
        box.state = "destroyed";
      },
      async recover(t) {
        fake.calls.push({ op: "recover", args: [id, t] });
        box.state = "started";
      },
      async refreshActivity() {
        fake.calls.push({ op: "refreshActivity", args: [id] });
      },
      async setAutostopInterval(m) {
        fake.calls.push({ op: "setAutostopInterval", args: [id, m] });
      },
      async exec(command, t) {
        fake.calls.push({ op: "exec", args: [command, t] });
        const r = spawnSync("bash", ["-c", command], { env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH}` }, encoding: "utf8" });
        return { exitCode: r.status ?? 1, result: r.stdout };
      },
      async upload(data, p) {
        fake.calls.push({ op: "upload", args: [p, data.length] });
        writeFileSync(p, data);
      },
      async previewUrl(port, ttl) {
        fake.calls.push({ op: "previewUrl", args: [port, ttl] });
        return `https://${port}-tok.proxy.daytona.works/`;
      },
    };
    return box;
  }

  async create(params: DaytonaCreateParams, t: number) {
    const id = `dt${this.boxes.size + 1}`;
    this.calls.push({ op: "create", args: [params, t] });
    const box = this.make(id, "started");
    this.boxes.set(id, box);
    return box;
  }
  async get(id: string) {
    this.calls.push({ op: "get", args: [id] });
    if (this.getError) throw this.getError;
    const box = this.boxes.get(id);
    if (!box || box.state === "destroyed") throw Object.assign(named("DaytonaNotFoundError", `Sandbox ${id} not found`), { statusCode: 404 });
    return box;
  }
  ops = () => this.calls.map((c) => c.op);
}

test("Daytona: cria com labels, parada por ociosidade e arquivo em 7 dias, nunca apaga sozinho", async () => {
  const client = new FakeDaytona(shims());
  const p = daytonaProvider(client)("dtn_chave");
  assert.equal(p.id, "daytona");
  const { ref } = await p.create({ ...createInput, idleMs: 90_000 });
  assert.equal(ref, "dt1");
  const [params, timeout] = client.calls[0].args as [DaytonaCreateParams, number];
  assert.deepEqual(params, {
    labels: { spherum_agency: "ag-1", spherum_computer: "pc-1", generation: "3" },
    autoStopInterval: 2,
    autoArchiveInterval: 10_080,
    autoDeleteInterval: -1,
    public: false,
  });
  assert.equal(timeout, 120);
  assert.throws(() => daytonaProvider(client)(""), /chave do Daytona/);
});

test("Daytona: pausa para, retoma liga e sobe os serviços da tela, estende renova a atividade, destrói uma vez", async () => {
  const client = new FakeDaytona(shims());
  const p = new DaytonaProvider("k", client);
  const { ref } = await p.create(createInput);
  await p.pause(ref);
  assert.deepEqual(client.calls.find((c) => c.op === "stop")!.args, [ref, 120]);
  await assert.rejects(p.run(ref, { script: "true", user: "root", timeoutMs: 1000 }), (e) => e instanceof Error && /parada/.test(e.message) && !p.isGone(e));
  await p.resume(ref, 300_000);
  assert.deepEqual(client.calls.find((c) => c.op === "start")!.args, [ref, 120]);
  assert.deepEqual(client.calls.find((c) => c.op === "setAutostopInterval")!.args, [ref, 5]);
  const restart = client.calls.filter((c) => c.op === "exec").at(-1)!.args[0] as string;
  assert.match(restart, /spherum-start/, "a memória não volta no Daytona: a tela sobe de novo");
  await p.extend(ref, 300_000);
  assert.equal(client.ops().at(-1), "refreshActivity");
  await p.destroy(ref);
  await p.destroy(ref);
  assert.equal(client.ops().filter((o) => o === "remove").length, 1, "já apagada: nada a fazer");
  await assert.rejects(p.extend(ref, 300_000), (e) => e instanceof SandboxGone && p.isGone(e));
  await assert.rejects(p.pause(ref), (e) => p.isGone(e));
  // Erro de rede ao buscar a máquina não é prova de que sumiu.
  client.getError = new Error("ECONNRESET");
  await assert.rejects(p.resume(ref, 300_000), (e) => !p.isGone(e));
});

test("Daytona: run separa saída e erro, devolve o código, passa a entrada e usa o xodo por setpriv", { skip: !HAS_BASH }, async () => {
  const shim = shims();
  const client = new FakeDaytona(shim);
  const p = new DaytonaProvider("k", client);
  const { ref } = await p.create(createInput);
  const r = await p.run(ref, { script: "printf 'saída'; echo 'erro' >&2; exit 3", user: "root", timeoutMs: 5000 });
  assert.deepEqual(r, { code: 3, stdout: "saída", stderr: "erro\n" });
  const piped = await p.run(ref, { script: "tr a-z A-Z", user: "root", stdin: "texto com 'aspas' e $HOME", timeoutMs: 5000 });
  assert.equal(piped.stdout, "TEXTO COM 'ASPAS' E $HOME");
  assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith("spherum-in-") || f.startsWith("spherum-err-")).length, 0, "temporários apagados");

  const cwd = mkdtempSync(path.join(tmpdir(), "spherum-cwd-"));
  const asXodo = await p.run(ref, { script: "pwd", user: "xodo", cwd, timeoutMs: 5000 });
  assert.equal(asXodo.stdout.trim(), cwd);
  assert.match(readFileSync(shim.log, "utf8"), /setpriv --reuid=xodo --regid=xodo --init-groups -- bash -c/);

  // Gravar e ler (binário) passam pelo mesmo caminho.
  const file = path.join(cwd, "sub", "dado.bin");
  await p.write(ref, file, new Uint8Array([0, 255, 10, 39]));
  assert.deepEqual([...readFileSync(file)], [0, 255, 10, 39]);
  assert.deepEqual([...(await p.read(ref, file, 100))], [0, 255, 10, 39]);
  assert.deepEqual([...(await p.read(ref, file, 2))], [0, 255], "só o começo");
  await assert.rejects(p.read(ref, path.join(cwd, "nao-existe"), 10), /No such file/);
  assert.equal(await p.publicUrl(ref, 6100), "https://6100-tok.proxy.daytona.works");
  assert.deepEqual(client.calls.find((c) => c.op === "previewUrl")!.args, [6100, 3600]);
  rmSync(cwd, { recursive: true, force: true });
});

test("Daytona: só 404 da API prova que a máquina sumiu; prazo estourado vira 124", async () => {
  const client = new FakeDaytona(shims());
  const p = new DaytonaProvider("k", client);
  const { ref } = await p.create(createInput);
  const box = client.boxes.get(ref)!;
  box.exec = async () => {
    throw named("DaytonaProcessExecutionTimeoutError", "timeout");
  };
  assert.equal((await p.run(ref, { script: "sleep 9", user: "root", timeoutMs: 1000 })).code, 124);
  box.exec = async () => {
    throw Object.assign(named("DaytonaFileNotFoundError", "file not found"), { statusCode: 404 });
  };
  const missing = await p.run(ref, { script: "true", user: "root", timeoutMs: 1000 }).catch((e: unknown) => e);
  assert.equal(p.isGone(missing), false, "arquivo que falta numa máquina viva não é máquina sumida");
  client.boxes.delete(ref);
  const gone = await p.run("dt-que-nao-existe", { script: "true", user: "root", timeoutMs: 1000 }).catch((e: unknown) => e);
  assert.equal(p.isGone(gone), true);
});

test("Daytona: splitOutput acha o marcador mesmo com a saída aparada", () => {
  const m = "__SPHERUM_STDERR_abc__";
  const err = Buffer.from("ops\n").toString("base64");
  assert.deepEqual(splitOutput(0, `oi\n${m}\n${err}`, m), { code: 0, stdout: "oi", stderr: "ops\n" });
  assert.deepEqual(splitOutput(1, `oi\n\n${m}`, m), { code: 1, stdout: "oi\n", stderr: "" });
  assert.deepEqual(splitOutput(0, `${m}\n${err}`, m), { code: 0, stdout: "", stderr: "ops\n" });
  assert.deepEqual(splitOutput(0, "sem marcador", m), { code: 0, stdout: "sem marcador", stderr: "" });
});

// ---------------------------------------------------------------------------
// Preparo
// ---------------------------------------------------------------------------

const sandbox = (rel: string) => readFileSync(path.join(SANDBOX_DIR, rel), "utf8");

test("preparo: manda todos os arquivos de sandbox/ e roda o prepare.sh como root com o ambiente do provedor", async () => {
  const world = fakeWorld();
  const base = fakeProvider(world)("k");
  const provider: SandboxProvider = { ...base, id: "e2b" };
  const { ref } = await provider.create(createInput);
  world.calls.length = 0;
  await prepareMachine(provider, ref, { egressMode: "aberto" });

  const files = loadSandboxFiles();
  const written = world.calls.filter((c) => c.op === "write").map((c) => c.detail as string);
  assert.deepEqual(written, files.map((f) => `${PREPARE_DIR}/${f.path}`));
  for (const required of [
    "prepare.sh",
    "bin/spherum-lib.sh",
    "bin/spherum-start",
    "bin/spherum-tela",
    "bin/spherum-navegador",
    "bin/spherum-vnc",
    "bin/spherum-gateway",
    "bin/spherum-vigia",
    "bin/spherum-control-vnc",
    "bin/spherum-pty",
    "bin/spherum-pty-server.py",
    "bin/spherum-start-control",
    "bin/spherum-stop-control",
    "bin/spherum-write-token",
    "bin/spherum-revoke-token",
    "web/view.html",
    "web/terminal.html",
  ]) {
    assert.ok(files.some((f) => f.path === required), `falta ${required}`);
  }
  if (existsSync(path.join(SANDBOX_DIR, "page-browser.py"))) assert.ok(written.includes(`${PREPARE_DIR}/page-browser.py`));
  const machine = world.machines.get(ref)!;
  assert.equal(new TextDecoder().decode(machine.files.get(`${PREPARE_DIR}/prepare.sh`)), sandbox("prepare.sh"));

  const runs = world.calls.filter((c) => c.op === "run").map((c) => c.detail as { script: string; user: string });
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.user === "root"));
  assert.match(runs[0].script, /^rm -rf -- \/opt\/spherum\/\.preparo && mkdir -p/);
  assert.equal(
    runs[1].script,
    `SPHERUM_STAGING='/opt/spherum/.preparo' SPHERUM_EGRESS='aberto' SPHERUM_TEMPLATE_USER='user' SPHERUM_ALLOWED_PORTS='49983' SPHERUM_RUNTIME_VERSION='${RUNTIME_VERSION}' bash /opt/spherum/.preparo/prepare.sh`,
  );
  assert.match(prepareCommand("daytona", "restrito"), /SPHERUM_EGRESS='restrito' SPHERUM_TEMPLATE_USER='' SPHERUM_ALLOWED_PORTS='2280 22220 22222'/);
  assert.throws(() => prepareCommand("e2b", "tudo" as "aberto"), /modo de rede/);
  assert.throws(() => prepareCommand("e2b", "aberto", "x; rm -rf /"), /versão/);

  // Falha no preparo: a mensagem traz a linha de ERRO (limpa), não o log inteiro.
  world.onRun = (script) =>
    script.includes("prepare.sh")
      ? { code: 1, stdout: "", stderr: "instalando...\nspherum-preparo: ERRO: porta exposta fora do loopback: 0.0.0.0:9222\n" }
      : { code: 0, stdout: "", stderr: "" };
  await assert.rejects(prepareMachine(provider, ref, { egressMode: "aberto" }), /preparo da máquina falhou \(código 1\): spherum-preparo: ERRO: porta exposta/);

  // O provedor falso não tem máquina de verdade: nada roda.
  const fake = fakeProvider(world)("k");
  const before = world.calls.length;
  await prepareMachine(fake, ref, { egressMode: "aberto" });
  assert.equal(world.calls.length, before);
});

test("preparo: xodo sem sudo, rede bloqueada por uid, CDP só em loopback e verificação final", () => {
  const prep = sandbox("prepare.sh");
  // Usuário xodo uid 1000, sem grupos extras, sem sudoers, sem senha; o usuário do template perde o sudo.
  assert.match(prep, /useradd -u 1000 /);
  assert.match(prep, /usermod -G "" "\$XODO"/);
  assert.match(prep, /strip_sudoers "\$XODO"/);
  assert.match(prep, /strip_sudoers "\$TEMPLATE_USER"/);
  assert.match(prep, /gpasswd -d "\$TEMPLATE_USER"/);
  assert.match(prep, /passwd -l root/);
  assert.match(prep, /o xodo ainda tem sudo/);
  // Rede: as faixas privadas, metadata, CGNAT, IPv6 local e SMTP, só para o uid do xodo; sem iptables, aborta.
  for (const net of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "fc00::/7"]) {
    assert.ok(prep.includes(net), `falta ${net}`);
  }
  assert.match(prep, /--dports 25,465,587 -j REJECT/);
  assert.match(prep, /for uid in "\$XUID" "\$NUID"; do/);
  assert.match(prep, /-m owner --uid-owner "\$uid" -j SPHERUM_XODO/);
  // Loopback: CDP fechado para o xodo e agentes do provedor fechados para os dois, antes de liberar o lo.
  const cdp = prep.indexOf('--dport 9222 -m owner --uid-owner "$XUID" -j REJECT');
  const agents = prep.indexOf('-o lo -p tcp --dport "$p" -j REJECT');
  const lo = prep.indexOf("-A SPHERUM_XODO -o lo -j RETURN");
  assert.ok(cdp > 0 && agents > cdp && lo > agents, "bloqueios do loopback antes de liberar o lo");
  assert.match(prep, /iptables não funciona nesta máquina/);
  // Pastas do xodó com dono xodo.
  for (const dir of ["agencia", "clientes", "xodos", "downloads", ".lixeira"]) assert.ok(prep.includes(`"$SPHERUM_HOME/${dir}"`), dir);
  // Perfis do navegador só dele; downloads com o grupo do xodo; perfis antigos na casa do xodo saem.
  assert.match(prep, /install -d -m 0700 -o "\$NUID" -g "\$NUID" "\$NAV_HOME" "\$NAV_HOME\/\.perfis"/);
  assert.match(prep, /install -d -m 2770 -o "\$XUID" -g "\$XGID" "\$SPHERUM_HOME\/downloads"/);
  assert.match(prep, /rm -rf -- "\$XODO_HOME\/\.perfis"/);
  assert.match(prep, /o xodo lê os perfis do navegador/);
  assert.match(prep, /strip_sudoers "\$NAV"/);
  // Sem terminal gráfico: menu só com o navegador e terminais trancados para o xodo.
  assert.match(prep, /\[exec\] \(Navegador\) \{\/usr\/local\/bin\/chromium\}/);
  assert.doesNotMatch(prep.split("cat >\"$ETC/fluxbox/menu\"")[1].split("EOF")[1], /xterm/);
  assert.match(prep, /TERMINALS="xterm uxterm/);
  assert.match(prep, /chmod 0700 "\$target"/);
  // page-browser.py só é copiado (quem escreve é a frente do navegador).
  assert.match(prep, /install -m 0755 -o root -g root "\$STAGING\/page-browser.py" "\$BIN\/page-browser.py"/);
  // Verificação final: só a 6100 fora do loopback, CDP nunca exposto, pastas de root.
  assert.match(prep, /ss -Htlnp/);
  assert.match(prep, /porta exposta fora do loopback/);
  assert.match(prep, /o CDP do navegador está exposto/);
  assert.match(prep, /\/run\/spherum precisa ser de root com 0700/);
  assert.ok(prep.indexOf("Verificação final") > prep.indexOf('"$BIN/spherum-start"'), "verifica depois de subir tudo");

  const tela = sandbox("bin/spherum-tela");
  assert.match(tela, /Xvfb "\$SPHERUM_DISPLAY" -screen 0 1280x800x24 -auth "\$SPHERUM_XAUTH" -nolisten tcp/);
  assert.doesNotMatch(tela, / -ac /, "a tela pede o cookie do X");
  assert.match(sandbox("bin/spherum-lib.sh"), /SPHERUM_DISPLAY=:20/);
  assert.match(tela, /SPHERUM_AS_NAV\[@\]\}" Xvfb/, "a tela roda como navegador");
  assert.doesNotMatch(sandbox("bin/spherum-lib.sh").split("SPHERUM_AS_XODO=(")[1].split(")")[0], /DISPLAY/, "o xodo não recebe a tela");
  const nav = sandbox("bin/spherum-navegador");
  assert.match(nav, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(nav, /--remote-debugging-port="\$SPHERUM_CDP_PORT"/);
  assert.match(sandbox("bin/spherum-lib.sh"), /SPHERUM_CDP_PORT=9222/);
  assert.match(nav, /\$PERFIS\/agencia/);
  assert.match(sandbox("bin/spherum-vnc"), /x11vnc .*-viewonly -nopw -rfbport 0 -localhost -unixsock "\$VIEW_SOCKET"/);
  const controlVnc = sandbox("bin/spherum-control-vnc").split("\n").find((l) => l.includes("setsid x11vnc"))!;
  assert.match(controlVnc, /-unixsock "\$CONTROL_SOCKET"/);
  assert.doesNotMatch(controlVnc, /-viewonly/, "o VNC de controle aceita mouse e teclado");
  const gw = sandbox("bin/spherum-gateway");
  assert.match(gw, /--web="\$SPHERUM_WEB" --token-plugin=TokenFile --token-source="\$TOKEN_DIR"/);
  assert.match(gw, /"0\.0\.0\.0:\$SPHERUM_GATEWAY_PORT"/);
  const lib = sandbox("bin/spherum-lib.sh");
  assert.match(lib, /TOKEN_DIR=\$SPHERUM_RUN\/tokens/);
  assert.match(lib, /chmod 700 "\$SPHERUM_RUN" "\$TOKEN_DIR"/);
  // Mesmos caminhos que o controle usa.
  const control = readFileSync("src/lib/computer/control.ts", "utf8");
  for (const s of ["/run/spherum/tokens", "/run/spherum/expiry", "/run/spherum/vnc-view.sock", "/run/spherum/vnc-control.sock", "/run/spherum/pty.sock", "/opt/spherum/bin/spherum-control-vnc", "/opt/spherum/bin/spherum-pty"]) {
    assert.ok(control.includes(s), `control.ts usa ${s}`);
  }
  const pty = sandbox("bin/spherum-pty-server.py");
  assert.match(pty, /os\.setuid\(entry\.pw_uid\)/);
  assert.match(pty, /PR_SET_NO_NEW_PRIVS/);
});

test("preparo: scripts sem erro de sintaxe", { skip: !HAS_BASH }, () => {
  const scripts = ["prepare.sh", ...readdirSync(path.join(SANDBOX_DIR, "bin")).filter((f) => !f.endsWith(".py")).map((f) => `bin/${f}`)];
  for (const s of scripts) {
    const r = spawnSync("bash", ["-n", path.join(SANDBOX_DIR, s)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${s}: ${r.stderr}`);
  }
});

/** Copia um script de sandbox/bin apontando a biblioteca para uma pasta de teste (sem root). */
function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "spherum-maquina-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const lib = sandbox("bin/spherum-lib.sh")
    .replace("SPHERUM_RUN=/run/spherum", `SPHERUM_RUN=${root}/run`)
    .replace("SPHERUM_BIN=/opt/spherum/bin", `SPHERUM_BIN=${bin}`)
    .replace("SPHERUM_LOG=/var/log/spherum", `SPHERUM_LOG=${root}/log`)
    .concat(`\nspherum_require_root() { :; }\nspherum_dirs() { mkdir -p "$TOKEN_DIR" "$EXPIRY_DIR" "$STAGING_DIR" "$PTY_SHELLS" "$SPHERUM_LOG"; }\n`);
  writeFileSync(path.join(bin, "spherum-lib.sh"), lib);
  const install = (name: string, body?: string) => {
    const text = (body ?? sandbox(`bin/${name}`)).replaceAll("/opt/spherum/bin/spherum-lib.sh", path.join(bin, "spherum-lib.sh"));
    writeFileSync(path.join(bin, name), text);
    chmodSync(path.join(bin, name), 0o755);
  };
  return { root, bin, install, run: path.join(root, "run") };
}

test("vigia: apaga tokens vencidos ou sem vencimento e derruba o controle vencido", { skip: !HAS_BASH }, () => {
  const h = harness();
  const marker = path.join(h.root, "parou");
  h.install("spherum-stop-control", `#!/usr/bin/env bash\necho parou >> ${marker}\n`);
  h.install("spherum-control-vnc", "#!/usr/bin/env bash\nexit 1\n");
  h.install("spherum-pty", "#!/usr/bin/env bash\nexit 1\n");
  const vigia = sandbox("bin/spherum-vigia");
  const sweep = vigia.slice(vigia.indexOf("sweep() {"), vigia.indexOf("\ntick=0"));
  const now = Math.floor(Date.now() / 1000);
  for (const d of ["tokens", "expiry"]) mkdirSync(path.join(h.run, d), { recursive: true });
  const put = (name: string, exp?: number) => {
    writeFileSync(path.join(h.run, "tokens", name), `v-xxxxxxxxxxxxxxxxxxxx: unix_socket:/run/spherum/vnc-view.sock\n`);
    if (exp !== undefined) writeFileSync(path.join(h.run, "expiry", name), `${exp}\n`);
  };
  put("control", now - 5);
  put("view-aaaaaaaaaaaaaaaa", now + 600);
  put("view-bbbbbbbbbbbbbbbb", now - 1);
  put("sem-prazo");
  const r = spawnSync("bash", ["-c", `. ${path.join(h.bin, "spherum-lib.sh")}\n${sweep}\nsweep`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(path.join(h.run, "tokens")).sort(), ["view-aaaaaaaaaaaaaaaa"]);
  assert.deepEqual(readdirSync(path.join(h.run, "expiry")).sort(), ["view-aaaaaaaaaaaaaaaa"]);
  assert.equal(readFileSync(marker, "utf8").trim(), "parou", "o controle vencido derruba o VNC de controle e o terminal");
  rmSync(h.root, { recursive: true, force: true });
});

test("write-token: só tokens do alfabeto certo e sockets de /run/spherum, com vencimento antes do token", { skip: !HAS_BASH }, () => {
  const h = harness();
  h.install("spherum-write-token");
  const run = (args: string[], input: string) => spawnSync(path.join(h.bin, "spherum-write-token"), args, { input, encoding: "utf8" });
  const future = String(Math.floor(Date.now() / 1000) + 900);
  const tok = "c-" + "A".repeat(43);
  const ok = run(["control", future], `${tok}: unix_socket:/run/spherum/vnc-control.sock\nt-${"b".repeat(43)}: unix_socket:/run/spherum/pty.sock\n`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(path.join(h.run, "expiry", "control"), "utf8").trim(), future);
  assert.match(readFileSync(path.join(h.run, "tokens", "control"), "utf8"), /^c-A{43}: unix_socket:\/run\/spherum\/vnc-control\.sock\nt-b{43}: /);
  for (const [args, input] of [
    [["control", future], `${tok}: unix_socket:/etc/shadow.sock\n`],
    [["control", future], `${tok}: 127.0.0.1:22\n`],
    [["control", future], `c-curto: unix_socket:/run/spherum/pty.sock\n`],
    [["../x", future], `${tok}: unix_socket:/run/spherum/pty.sock\n`],
    [["control", "1"], `${tok}: unix_socket:/run/spherum/pty.sock\n`],
    [["control", "9e9"], `${tok}: unix_socket:/run/spherum/pty.sock\n`],
  ] as [string[], string][]) {
    assert.notEqual(run(args, input).status, 0, `${args.join(" ")} ${input}`);
  }
  rmSync(h.root, { recursive: true, force: true });
});

test("páginas da tela e do terminal: token do fragmento, sem referrer, xterm por CDN fixo com integridade", () => {
  const view = sandbox("web/view.html");
  const term = sandbox("web/terminal.html");
  for (const page of [view, term]) {
    assert.match(page, /<meta name="referrer" content="no-referrer" \/>/);
    assert.match(page, /window\.location\.hash/);
    assert.match(page, /history\.replaceState/);
    assert.match(page, /Content-Security-Policy/);
    assert.doesNotMatch(page, /location\.search|localStorage/);
  }
  assert.match(view, /\^\[vc\]-\[A-Za-z0-9_-\]/);
  assert.match(view, /rfb\.viewOnly = soAssistir/);
  assert.match(term, /\^t-\[A-Za-z0-9_-\]/);
  const external = [...term.matchAll(/(?:src|href)="(https:[^"]+)"/g)].map((m) => m[1]);
  assert.equal(external.length, 3);
  for (const url of external) assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@xterm\/[a-z-]+@\d+\.\d+\.\d+\//, "versão exata");
  assert.equal([...term.matchAll(/integrity="sha384-[A-Za-z0-9+/=]{64}"/g)].length, 3);
  assert.equal([...term.matchAll(/crossorigin="anonymous"/g)].length, 3);
});

test("RUNTIME_VERSION é o hash do preparo e muda quando o preparo muda", () => {
  const files = loadSandboxFiles();
  assert.equal(RUNTIME_VERSION, runtimeVersionOf(files));
  assert.match(RUNTIME_VERSION, /^[0-9a-f]{16}$/);
  assert.equal(runtimeVersionOf([...files].reverse()), RUNTIME_VERSION, "a ordem não importa");

  const changed = files.map((f) => (f.path === "prepare.sh" ? { ...f, data: Buffer.concat([f.data, Buffer.from("\n# mudou\n")]) } : f));
  assert.notEqual(runtimeVersionOf(changed), RUNTIME_VERSION);
  const added = [...files, { path: "bin/spherum-novo", data: Buffer.from("#!/bin/sh\n") }];
  assert.notEqual(runtimeVersionOf(added), RUNTIME_VERSION);
  const renamed = files.map((f) => (f.path === "web/view.html" ? { ...f, path: "web/tela.html" } : f));
  assert.notEqual(runtimeVersionOf(renamed), RUNTIME_VERSION);

  // Uma cópia da pasta com um script mudado dá outra versão; ocultos e caches ficam fora.
  const copy = mkdtempSync(path.join(tmpdir(), "spherum-sandbox-"));
  cpSync(SANDBOX_DIR, copy, { recursive: true });
  mkdirSync(path.join(copy, "bin", "__pycache__"), { recursive: true });
  writeFileSync(path.join(copy, "bin", ".rascunho"), "x");
  assert.equal(runtimeVersionOf(loadSandboxFiles(copy)), RUNTIME_VERSION);
  writeFileSync(path.join(copy, "bin", "spherum-vigia"), `${readFileSync(path.join(copy, "bin", "spherum-vigia"), "utf8")}\n# outro intervalo\n`);
  assert.notEqual(runtimeVersionOf(loadSandboxFiles(copy)), RUNTIME_VERSION);
  rmSync(copy, { recursive: true, force: true });
});
