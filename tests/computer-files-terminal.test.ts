import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { FOLDERS, HOME, XODO_ENV } from "../src/lib/computer/desktop";
import { configureComputer, ensureRunning, type ComputerDeps } from "../src/lib/computer/lifecycle";
import type { ComputerStorage, RunResult } from "../src/lib/computer/provider";
import { fakeProvider, fakeWorld, type FakeWorld } from "../src/lib/computer/providers/fake";
import { classifyCommand, type CommandVerdict } from "../src/lib/computer/safety-floor";
import { objectPath, storageFromEnv, supabaseStorage, StorageError } from "../src/lib/computer/storage";
import { FILES_TOOLS, MAX_ATTACH_BYTES } from "../src/lib/computer/tools/files";
import { NEVER_LIST, TERMINAL_TOOLS, terminalTools } from "../src/lib/computer/tools/terminal";
import { decideAction } from "../src/lib/xodos/actions";
import { one, type Sql } from "../src/lib/xodos/db";
import { decideApproval } from "../src/lib/xodos/policy";
import { continueRun, startRun, toolsFor, type EngineDeps } from "../src/lib/xodos/runner";
import { ToolError, type ToolContext, type ToolDef } from "../src/lib/xodos/tools";
import type { Xodo } from "../src/lib/xodos/types";
import { credentialAad, sealSecret } from "../src/lib/xodos/vault";
import { Clock, createTestDb, FakeModel, seedAgency, seedClient, seedXodo, testDeps } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
// Formato de token do GitHub, inventado: a limpeza precisa tirar.
const FAKE_TOKEN = `ghp_${"A1b2".repeat(10)}`;
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

// ---------------------------------------------------------------------------
// Shell de mentira: entende os scripts das ferramentas (marcados com "# spherum:<op>") sobre os
// arquivos da máquina falsa, com pastas e links.
// ---------------------------------------------------------------------------

const WRAP = `${XODO_ENV} bash -lc `;
const unquote = (s: string) => s.split(`'\\''`).join("'");

function unwrap(script: string): string | null {
  if (!script.startsWith(WRAP)) return null;
  const quoted = script.slice(WRAP.length);
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), "o script vai inteiro entre aspas simples");
  return unquote(quoted.slice(1, -1));
}

function shellVars(inner: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of inner.split("\n")) {
    const m = /^([a-z])=(?:'((?:[^']|'\\'')*)'|([a-z0-9]+))$/.exec(line);
    if (m) vars[m[1]] = m[2] !== undefined ? unquote(m[2]) : m[3];
  }
  return vars;
}

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

class FakeShell {
  dirs = new Set<string>([HOME, ...Object.values(FOLDERS)]);
  links = new Map<string, string>();
  ops: { op: string; vars: Record<string, string>; stdin?: string; cwd?: string; script: string }[] = [];
  terminal: (command: string, o: { cwd?: string; seconds: number }) => RunResult = () => ok();

  constructor(private world: FakeWorld) {}

  get files() {
    const machine = [...this.world.machines.values()].find((m) => m.state === "running");
    if (!machine) throw new Error("sem máquina ligada");
    return machine.files;
  }
  put(rel: string, content: string | Uint8Array) {
    this.files.set(`${HOME}/${rel}`, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }
  text(rel: string) {
    const data = this.files.get(`${HOME}/${rel}`);
    return data ? new TextDecoder().decode(data) : null;
  }
  isDir(p: string) {
    if (this.dirs.has(p)) return true;
    const pre = `${p}/`;
    return [...this.files.keys(), ...this.dirs, ...this.links.keys()].some((k) => k.startsWith(pre));
  }
  realpath(p: string) {
    let pending = p.split("/").filter(Boolean);
    let out: string[] = [];
    let hops = 0;
    while (pending.length) {
      const seg = pending.shift()!;
      if (seg === ".") continue;
      if (seg === "..") {
        out.pop();
        continue;
      }
      const target = this.links.get(`/${[...out, seg].join("/")}`);
      if (target !== undefined && hops++ < 40) {
        if (target.startsWith("/")) out = [];
        pending = [...target.split("/").filter(Boolean), ...pending];
        continue;
      }
      out.push(seg);
    }
    return `/${out.join("/")}`;
  }
  typeOf(r: string) {
    if (this.links.has(r)) return "l";
    if (this.isDir(r)) return "d";
    return this.files.has(r) ? "f" : "n";
  }
  move(from: string, to: string) {
    const remap = <V>(map: Map<string, V>) => {
      for (const [k, v] of [...map]) {
        if (k === from || k.startsWith(`${from}/`)) {
          map.delete(k);
          map.set(to + k.slice(from.length), v);
        }
      }
    };
    remap(this.files);
    remap(this.links);
    for (const d of [...this.dirs]) {
      if (d === from || d.startsWith(`${from}/`)) {
        this.dirs.delete(d);
        this.dirs.add(to + d.slice(from.length));
      }
    }
  }

  run(script: string, o: { cwd?: string; stdin?: string }): RunResult {
    const inner = unwrap(script);
    if (!inner) return ok();
    const op = /^# spherum:(\w+)/.exec(inner)?.[1] ?? "?";
    const v = shellVars(inner);
    this.ops.push({ op, vars: v, stdin: o.stdin, cwd: o.cwd, script });
    switch (op) {
      case "resolver": {
        const r = v.f === "1" ? this.realpath(v.p) : `${this.realpath(dirname(v.p))}/${basename(v.p)}`;
        const t = this.typeOf(r);
        return ok(`${t}\t${t === "f" ? this.files.get(r)!.length : 0}\t${HOME}\t${r}`);
      }
      case "listar": {
        const pre = `${v.p}/`;
        const kids = new Map<string, { y: string; size: number }>();
        for (const k of [...this.files.keys(), ...this.dirs, ...this.links.keys()]) {
          if (!k.startsWith(pre)) continue;
          const name = k.slice(pre.length).split("/")[0];
          const full = pre + name;
          kids.set(name, { y: this.typeOf(full), size: this.files.get(full)?.length ?? 4096 });
        }
        const names = [...kids.keys()].sort();
        const records = names.slice(0, Number(v.n)).map((n) => `${n}\t${kids.get(n)!.y}\t${kids.get(n)!.size}\t1760875200.0000000000\0`);
        return ok(`${names.length}\n${records.join("")}`);
      }
      case "baixar": {
        const data = this.files.get(v.p)!;
        return ok(Buffer.from(data.subarray(0, Number(v.n))).toString("base64"));
      }
      case "ler": {
        const data = this.files.get(v.p)!;
        const start = Number(v.o) - 1;
        return ok(Buffer.from(data.subarray(start, start + Number(v.l))).toString("base64"));
      }
      case "escrever": {
        const exists = this.files.has(v.p) || this.links.has(v.p) || this.isDir(v.p);
        if (v.m === "criar" && exists) return { code: 9, stdout: "", stderr: "exists" };
        if (v.m === "substituir" && !this.files.has(v.p)) return { code: 8, stdout: "", stderr: "" };
        this.files.set(v.p, new Uint8Array(Buffer.from(o.stdin ?? "", "base64")));
        return ok();
      }
      case "apagar": {
        if (this.typeOf(v.d) !== "n") return { code: 9, stdout: "", stderr: "" };
        this.move(v.p, v.d);
        return ok();
      }
      case "terminal": {
        assert.match(inner, /^set -o pipefail$/m, "o código de saída é o do comando");
        const m = /^\{ timeout -k 5 (\d+) bash -c '((?:[^']|'\\'')*)' < \/dev\/null 2>&1 1>&3 3>&- \| tail -c 16384 1>&2; exit "\$\{PIPESTATUS\[0\]\}"; \} 3>&1 \| tail -c 65536$/m.exec(inner);
        assert.ok(m, "o comando roda com timeout, entre aspas, e só o fim das saídas sai da máquina");
        return this.terminal(unquote(m[2]), { cwd: o.cwd, seconds: Number(m[1]) });
      }
      default:
        return ok();
    }
  }
}

class MemoryStorage implements ComputerStorage {
  objects = new Map<string, { data: Uint8Array; contentType: string }>();
  async upload(path: string, data: Uint8Array, contentType: string) {
    this.objects.set(path, { data, contentType });
  }
  async signedDownloadUrl(path: string) {
    return `https://storage.test/${path}?token=t`;
  }
  async signedUploadUrl(path: string) {
    return `https://storage.test/upload/${path}?token=t`;
  }
  async remove(path: string) {
    this.objects.delete(path);
  }
}

async function setup(o: { xodo?: Partial<Record<keyof Xodo, unknown>>; storage?: boolean } = {}) {
  const { agencyId, ownerId } = await seedAgency(sql);
  const world = fakeWorld();
  const shell = new FakeShell(world);
  world.onRun = (script, opts) => shell.run(script, opts);
  const clock = new Clock(new Date("2026-10-19T12:00:00Z"));
  const storage = new MemoryStorage();
  const computer = { masterKey: MASTER, providers: { e2b: fakeProvider(world) }, ...(o.storage === false ? {} : { storage }) };
  const deps: ComputerDeps = { sql, now: clock.now, ...computer };
  const id = randomUUID();
  await sql.query(`insert into ai_credentials (id, agency_id, provider, label, ciphertext, key_last4, kind) values ($1, $2, 'e2b', 'x', $3, 'abcd', 'sandbox')`, [
    id,
    agencyId,
    await sealSecret("k", credentialAad(agencyId, id), MASTER),
  ]);
  await configureComputer(deps, agencyId, { provider: "e2b", credential_id: id });
  await ensureRunning(deps, agencyId);
  const xodo = await seedXodo(sql, agencyId, { computer_mode: "cloud", computer_files: true, computer_terminal: true, ...o.xodo });
  const ctx = (runId = randomUUID()): ToolContext => ({ sql, xodo, runId, now: clock.now(), apps: null, computer: deps });
  const engine = (model: FakeModel): EngineDeps => ({ ...testDeps(sql, model, clock), computer });
  return { agencyId, ownerId, world, shell, clock, storage, xodo, ctx, engine };
}

const byName = (tools: readonly ToolDef[], name: string) => tools.find((t) => t.name === name)!;
const files = (name: string) => byName(FILES_TOOLS, name);
const exec = (tool: ToolDef, ctx: ToolContext, raw: unknown) => tool.execute(ctx, tool.input.parse(raw)) as Promise<Record<string, unknown>>;
const toolError = (pattern: RegExp) => (e: unknown) => e instanceof ToolError && pattern.test(e.message);

// ---------------------------------------------------------------------------
// Caminhos e alcance
// ---------------------------------------------------------------------------

test("caminhos maliciosos são recusados antes de tocar a máquina", async () => {
  const s = await setup();
  const ler = files("arquivo_ler");
  for (const bad of ["../etc/passwd", "/etc/passwd", "agencia/../../x", "agencia\\x", "a\u0000b", "agencia/\nx", "x".repeat(1025)]) {
    assert.equal(ler.input.safeParse({ caminho: bad }).success, false, `a entrada recusa ${JSON.stringify(bad.slice(0, 20))}`);
  }
  for (const [bad, why] of [
    [".perfis/agencia/Cookies", /perfis/],
    ["agencia/.perfis/x", /perfis/],
    ["etc/passwd", /Use uma das pastas/],
    ["clientes/nao-e-uuid/x", /Pasta de cliente inválida/],
  ] as const) {
    await assert.rejects(exec(ler, s.ctx(), { caminho: bad }), toolError(why));
  }
  assert.equal(s.shell.ops.length, 0, "nenhum comando chegou à máquina");
});

test("link que leva para fora da pasta (ou para outro cliente) é recusado pelo realpath", async () => {
  const s = await setup({ xodo: { client_scope: "selected" } });
  const mine = await seedClient(sql, s.agencyId, "Verano");
  const other = await seedClient(sql, s.agencyId, "Outro");
  await sql.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [s.xodo.id, mine, s.agencyId]);
  s.shell.links.set(`${HOME}/agencia/atalho`, "/etc");
  s.shell.links.set(`${HOME}/agencia/espiao`, `${HOME}/clientes/${other}`);
  s.shell.links.set(`${HOME}/agencia/meu`, `${HOME}/clientes/${mine}`);
  s.shell.put(`clientes/${other}/segredo.txt`, "não");
  s.shell.put(`clientes/${mine}/briefing.md`, "sim");
  const ler = files("arquivo_ler");
  await assert.rejects(exec(ler, s.ctx(), { caminho: "agencia/atalho/passwd" }), toolError(/para fora da pasta/));
  await assert.rejects(exec(ler, s.ctx(), { caminho: "agencia/espiao/segredo.txt" }), toolError(/para fora da pasta/));
  await assert.rejects(
    exec(files("arquivo_escrever"), s.ctx(), { caminho: "agencia/atalho/cron.d/x", conteudo: "x", modo: "criar" }),
    toolError(/para fora da pasta/),
  );
  // Link dentro do alcance funciona, e o caminho devolvido é o real.
  const out = await exec(ler, s.ctx(), { caminho: "agencia/meu/briefing.md" });
  assert.equal(out.conteudo, "sim");
  assert.equal(out.caminho, `clientes/${mine}/briefing.md`);
  assert.ok(!s.shell.ops.some((o) => o.op === "ler" && o.vars.p.includes(other)), "nunca leu o arquivo do outro cliente");
});

test("pasta de cliente exige o alcance do xodó; pasta de outro xodó é só dele; listagens mostram só o alcance", async () => {
  const s = await setup({ xodo: { client_scope: "selected" } });
  const mine = await seedClient(sql, s.agencyId, "Verano");
  const other = await seedClient(sql, s.agencyId, "Outro");
  await sql.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [s.xodo.id, mine, s.agencyId]);
  s.shell.dirs.add(`${HOME}/clientes/${mine}`).add(`${HOME}/clientes/${other}`);
  s.shell.dirs.add(`${HOME}/xodos/${s.xodo.id}`).add(`${HOME}/xodos/${randomUUID()}`);
  const escrever = files("arquivo_escrever");
  await assert.rejects(exec(files("arquivo_ler"), s.ctx(), { caminho: `clientes/${other}/x.txt` }), toolError(/fora do alcance/));
  await assert.rejects(exec(escrever, s.ctx(), { caminho: `xodos/${randomUUID()}/x.txt`, conteudo: "x", modo: "criar" }), toolError(/outro xodó/));
  await assert.rejects(exec(escrever, s.ctx(), { caminho: "clientes/x.txt", conteudo: "x", modo: "criar" }), toolError(/Pasta de cliente inválida/));
  await assert.rejects(exec(escrever, s.ctx(), { caminho: "clientes", conteudo: "x", modo: "criar" }), toolError(/pasta de um cliente/));
  await assert.rejects(exec(escrever, s.ctx(), { caminho: "solto.txt", conteudo: "x", modo: "criar" }), toolError(/Use uma das pastas/));
  await exec(escrever, s.ctx(), { caminho: `clientes/${mine}/notas.md`, conteudo: "ok", modo: "criar" });
  assert.equal(s.shell.text(`clientes/${mine}/notas.md`), "ok");

  const listar = files("arquivos_listar");
  const root = await exec(listar, s.ctx(), {});
  assert.deepEqual((root.itens as { nome: string }[]).map((i) => i.nome), [".lixeira", "agencia", "clientes", "downloads", "xodos"]);
  assert.equal(root.sua_pasta, `xodos/${s.xodo.id}`);
  const clients = await exec(listar, s.ctx(), { caminho: "clientes" });
  assert.deepEqual((clients.itens as { nome: string }[]).map((i) => i.nome), [mine]);
  assert.equal(clients.total, 1);
  const xodos = await exec(listar, s.ctx(), { caminho: "xodos/" });
  assert.deepEqual((xodos.itens as { nome: string; tipo: string }[]).map((i) => [i.nome, i.tipo]), [[s.xodo.id, "pasta"]]);

  // A estrutura não vira arquivo: nem a pasta de um cliente nem a do próprio xodó.
  for (const structure of [`clientes/${mine}`, `xodos/${s.xodo.id}`, "agencia"]) {
    await assert.rejects(exec(escrever, s.ctx(), { caminho: structure, conteudo: "x", modo: "criar" }), toolError(/estrutura/));
  }
});

test("a lixeira segue o alcance: o que era de outro cliente ou de outro xodó continua fora", async () => {
  const s = await setup({ xodo: { client_scope: "selected" } });
  const mine = await seedClient(sql, s.agencyId, "Verano");
  const other = await seedClient(sql, s.agencyId, "Outro");
  const otherXodo = randomUUID();
  await sql.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [s.xodo.id, mine, s.agencyId]);
  const bin = ".lixeira/2026-10-18T10-00-00Z-abcd";
  s.shell.put(`${bin}/clientes/${other}/contrato.txt`, "do outro cliente");
  s.shell.put(`${bin}/clientes/${mine}/notas.txt`, "meu");
  s.shell.put(`${bin}/xodos/${otherXodo}/rascunho.txt`, "do outro xodó");
  s.shell.put(`${bin}/agencia/velho.txt`, "da agência");
  const ler = files("arquivo_ler");
  await assert.rejects(exec(ler, s.ctx(), { caminho: `${bin}/clientes/${other}/contrato.txt` }), toolError(/fora do alcance/));
  await assert.rejects(exec(ler, s.ctx(), { caminho: `${bin}/xodos/${otherXodo}/rascunho.txt` }), toolError(/outro xodó/));
  await assert.rejects(exec(files("arquivo_anexar"), s.ctx(), { caminho: `${bin}/clientes/${other}/contrato.txt` }), toolError(/fora do alcance/));
  assert.equal((await exec(ler, s.ctx(), { caminho: `${bin}/clientes/${mine}/notas.txt` })).conteudo, "meu");
  assert.equal((await exec(ler, s.ctx(), { caminho: `${bin}/agencia/velho.txt` })).conteudo, "da agência");
  // Link para a lixeira de outro cliente também cai na regra.
  s.shell.links.set(`${HOME}/agencia/atalho`, `${HOME}/${bin}/clientes/${other}`);
  await assert.rejects(exec(ler, s.ctx(), { caminho: "agencia/atalho/contrato.txt" }), toolError(/para fora da pasta/));
  assert.ok(!s.shell.ops.some((o) => o.op === "ler" && o.vars.p.includes(other)), "nunca leu o arquivo do outro cliente");

  const listar = files("arquivos_listar");
  const clients = await exec(listar, s.ctx(), { caminho: `${bin}/clientes` });
  assert.deepEqual((clients.itens as { nome: string }[]).map((i) => i.nome), [mine]);
  const xodos = await exec(listar, s.ctx(), { caminho: `${bin}/xodos` });
  assert.deepEqual(xodos.itens, []);
});

test("a pasta do computador trocada por um link é recusada", async () => {
  const s = await setup();
  s.shell.put("agencia/a.txt", "a");
  s.shell.links.set(HOME, "/opt/outra");
  await assert.rejects(exec(files("arquivo_ler"), s.ctx(), { caminho: "agencia/a.txt" }), toolError(/para fora da pasta/));
});

// ---------------------------------------------------------------------------
// Escrever, ler, apagar, anexar
// ---------------------------------------------------------------------------

test("criar é rascunho e substituir é alteração; criar falha se já existe; conteúdo vai em base64, caminho entre aspas", async () => {
  const s = await setup();
  const escrever = files("arquivo_escrever");
  const ctx = s.ctx();
  assert.equal(await escrever.categoryFor!(ctx, escrever.input.parse({ caminho: "agencia/a.md", conteudo: "x", modo: "criar" })), "rascunho");
  assert.equal(await escrever.categoryFor!(ctx, escrever.input.parse({ caminho: "agencia/a.md", conteudo: "x", modo: "substituir" })), "alteracao");

  // Nome com aspas e $(...): chega intacto, sem virar comando.
  const tricky = "agencia/nota $(whoami) 'x'.txt";
  const text = "Relatório de outubro: ação ✓\nsegunda linha $HOME `id`";
  const out = await exec(escrever, ctx, { caminho: tricky, conteudo: text, modo: "criar" });
  assert.deepEqual(out, { caminho: tricky, modo: "criar", bytes: Buffer.byteLength(text) });
  assert.equal(s.shell.text(tricky), text);
  const write = s.shell.ops.find((o) => o.op === "escrever")!;
  assert.ok(!write.script.includes("Relatório"), "o conteúdo não vai no comando");
  assert.equal(Buffer.from(write.stdin!, "base64").toString("utf8"), text);

  await assert.rejects(exec(escrever, ctx, { caminho: tricky, conteudo: "outro", modo: "criar" }), toolError(/Já existe/));
  await exec(escrever, ctx, { caminho: tricky, conteudo: "novo", modo: "substituir" });
  assert.equal(s.shell.text(tricky), "novo");
  await assert.rejects(exec(escrever, ctx, { caminho: "agencia/nao-existe.md", conteudo: "x", modo: "substituir" }), toolError(/use modo "criar"/));
  await assert.rejects(exec(escrever, ctx, { caminho: "agencia", conteudo: "x", modo: "substituir" }), toolError(/estrutura/));
  s.shell.dirs.add(`${HOME}/agencia/sub`);
  await assert.rejects(exec(escrever, ctx, { caminho: "agencia/sub", conteudo: "x", modo: "substituir" }), toolError(/é uma pasta/));
  assert.equal(escrever.input.safeParse({ caminho: "agencia/x", conteudo: "x".repeat(100_001), modo: "criar" }).success, false);
});

test("ler: só texto UTF-8, em trechos que remontam o arquivo, limpo de dados sensíveis", async () => {
  const s = await setup();
  const ler = files("arquivo_ler");
  s.shell.put("agencia/config.txt", `conta: verano\ntoken do github: ${FAKE_TOKEN}\n`);
  const secret = await exec(ler, s.ctx(), { caminho: "agencia/config.txt" });
  assert.match(String(secret.conteudo), /\[removido\]/);
  assert.ok(!String(secret.conteudo).includes(FAKE_TOKEN));
  assert.equal(secret.proximo_offset, null);

  // Arquivo grande com acentos e emoji: os trechos nunca partem um caractere e remontam o original.
  const big = Array.from({ length: 1500 }, (_, i) => `linha ${i}: ação ✓ 😀 orçamento\n`).join("");
  s.shell.put("agencia/grande.txt", big);
  let offset: number | null = 0;
  let joined = "";
  let reads = 0;
  while (offset !== null) {
    const part: Record<string, unknown> = await exec(ler, s.ctx(), { caminho: "agencia/grande.txt", offset, limite: 5000 });
    joined += String(part.conteudo);
    offset = part.proximo_offset as number | null;
    reads += 1;
    assert.ok(reads < 100);
  }
  assert.equal(joined, big);
  assert.ok(reads > 5);

  // Offset no meio de um caractere: pula os bytes de continuação.
  s.shell.put("agencia/curto.txt", "ação");
  const mid = await exec(ler, s.ctx(), { caminho: "agencia/curto.txt", offset: 2 });
  assert.equal(mid.conteudo, "ão");

  // Um trecho pedido grande demais volta cortado em ~16 mil caracteres, com o próximo offset.
  const huge = await exec(ler, s.ctx(), { caminho: "agencia/grande.txt", limite: 250_000 });
  assert.ok(String(huge.conteudo).length <= 16_000);
  assert.equal(huge.proximo_offset, huge.bytes_lidos);

  s.shell.put("downloads/foto.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const bin = await exec(ler, s.ctx(), { caminho: "downloads/foto.png" });
  assert.equal(bin.binario, true);
  assert.equal(bin.conteudo, undefined);
  await assert.rejects(exec(ler, s.ctx(), { caminho: "agencia" }), toolError(/é uma pasta/));
  await assert.rejects(exec(ler, s.ctx(), { caminho: "agencia/sumiu.txt" }), toolError(/Não encontrei/));
  await assert.rejects(exec(ler, s.ctx(), { caminho: "agencia/curto.txt", offset: 99 }), toolError(/passou do fim/));
  assert.equal(ler.input.safeParse({ caminho: "agencia/x", limite: 250_001 }).success, false);
  assert.equal(ler.taints, true, "ler um arquivo deixa a execução mais cautelosa");
});

test("apagar manda para a lixeira com data; a lixeira é só leitura; a estrutura não se apaga", async () => {
  const s = await setup();
  const apagar = files("arquivo_apagar");
  s.shell.put("agencia/velho.txt", "antigo");
  s.shell.put("agencia/real.txt", "fica");
  s.shell.links.set(`${HOME}/agencia/atalho`, `${HOME}/agencia/real.txt`);
  const out = await exec(apagar, s.ctx(), { caminho: "agencia/velho.txt" });
  assert.match(String(out.movido_para), /^\.lixeira\/2026-10-19T12-00-00Z-[0-9a-f]{4}\/agencia\/velho\.txt$/);
  assert.equal(s.shell.text("agencia/velho.txt"), null);
  assert.equal(s.shell.text(String(out.movido_para)), "antigo");
  assert.equal(apagar.category, "alteracao");

  // Apagar um link tira o link, não o arquivo de destino.
  await exec(apagar, s.ctx(), { caminho: "agencia/atalho" });
  assert.equal(s.shell.text("agencia/real.txt"), "fica");
  assert.ok(!s.shell.links.has(`${HOME}/agencia/atalho`));

  // O xodó pode ler a lixeira, mas não apagar de vez nem escrever lá.
  const lido = await exec(files("arquivo_ler"), s.ctx(), { caminho: String(out.movido_para) });
  assert.equal(lido.conteudo, "antigo");
  await assert.rejects(exec(apagar, s.ctx(), { caminho: String(out.movido_para) }), toolError(/lixeira é só para consulta/));
  await assert.rejects(
    exec(files("arquivo_escrever"), s.ctx(), { caminho: ".lixeira/x.txt", conteudo: "x", modo: "criar" }),
    toolError(/lixeira é só para consulta/),
  );
  for (const structure of ["agencia", "downloads", `xodos/${s.xodo.id}`]) {
    await assert.rejects(exec(apagar, s.ctx(), { caminho: structure }), toolError(/estrutura/));
  }
  await assert.rejects(exec(apagar, s.ctx(), { caminho: "agencia/nada.txt" }), toolError(/Não encontrei/));
});

test("anexar sobe para o armazenamento e devolve o anexo; equipe, ou envio em canal com gente de fora", async () => {
  const s = await setup();
  const anexar = files("arquivo_anexar");
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2]);
  s.shell.put("downloads/relatorio.pdf", pdf);
  const out = (await exec(anexar, s.ctx(), { caminho: "downloads/relatorio.pdf", nome: "Relatório Verano.pdf" })) as {
    anexo: { id: string; path: string; nome: string; tamanho: number; tipo: string };
  };
  assert.equal(out.anexo.path, `${s.agencyId}/${out.anexo.id}`);
  assert.deepEqual([out.anexo.nome, out.anexo.tamanho, out.anexo.tipo], ["Relatório Verano.pdf", pdf.length, "application/pdf"]);
  const stored = s.storage.objects.get(out.anexo.path)!;
  assert.deepEqual([...stored.data], [...pdf]);
  assert.equal(stored.contentType, "application/pdf");
  assert.ok(!s.world.calls.some((c) => c.op === "read"), "lê como o usuário xodo, não pelo provider.read");
  assert.equal(anexar.category, "envio", "sem ver a conversa, fica a mais cautelosa");
  const event = await one<{ kind: string; status: string; summary: string }>(
    sql,
    `select kind, status, summary from computer_events where agency_id = $1 and kind = 'arquivo_anexar'`,
    [s.agencyId],
  );
  assert.deepEqual(event, { kind: "arquivo_anexar", status: "succeeded", summary: "arquivos: anexar downloads/relatorio.pdf como Relatório Verano.pdf" });

  s.shell.put("downloads/grande.bin", new Uint8Array(MAX_ATTACH_BYTES + 1));
  await assert.rejects(exec(anexar, s.ctx(), { caminho: "downloads/grande.bin" }), toolError(/25 MB/));
  assert.equal(anexar.input.safeParse({ caminho: "a/b", nome: "../x" }).success, false);

  // Sem conversa (app): equipe. Canal compartilhado com outra empresa: envio.
  assert.equal(await anexar.categoryFor!(s.ctx(), { caminho: "downloads/relatorio.pdf" }), "equipe");
  const conversation = await one<{ id: string }>(
    sql,
    `insert into xodo_conversations (agency_id, xodo_id, channel, external_key, metadata) values ($1, $2, 'slack', 'C1:1', '{"is_ext_shared": true}') returning id`,
    [s.agencyId, s.xodo.id],
  );
  const runId = randomUUID();
  await sql.query(
    `insert into xodo_runs (id, xodo_id, agency_id, trigger, provider, model, conversation_id, status) values ($1, $2, $3, 'channel', 'faux', 'faux-1', $4, 'completed')`,
    [runId, s.xodo.id, s.agencyId, conversation!.id],
  );
  assert.equal(await anexar.categoryFor!(s.ctx(runId), { caminho: "downloads/relatorio.pdf" }), "envio");
  // Slack interno: equipe. WhatsApp (gente de fora): envio.
  for (const [channel, metadata, expected] of [
    ["slack", "{}", "equipe"],
    ["whatsapp", "{}", "envio"],
  ] as const) {
    const conv = await one<{ id: string }>(
      sql,
      `insert into xodo_conversations (agency_id, xodo_id, channel, external_key, metadata) values ($1, $2, $3, $4, $5::jsonb) returning id`,
      [s.agencyId, s.xodo.id, channel, randomUUID(), metadata],
    );
    const run = randomUUID();
    await sql.query(
      `insert into xodo_runs (id, xodo_id, agency_id, trigger, provider, model, conversation_id, status) values ($1, $2, $3, 'channel', 'faux', 'faux-1', $4, 'completed')`,
      [run, s.xodo.id, s.agencyId, conv!.id],
    );
    assert.equal(await anexar.categoryFor!(s.ctx(run), { caminho: "downloads/relatorio.pdf" }), expected, channel);
  }

  const none = await setup({ storage: false });
  none.shell.put("downloads/a.txt", "a");
  await assert.rejects(exec(anexar, none.ctx(), { caminho: "downloads/a.txt" }), toolError(/armazenamento/));
});

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const fakeClassifier = (command: string): CommandVerdict => {
  if (command.startsWith("rm -rf /")) return { verdict: "deny", category: "exclusao", reason: "apagar a raiz" };
  if (command.includes("'")) return { verdict: "ask", category: "alteracao", reason: "comando ilegível" };
  if (command.startsWith("curl -d")) return { verdict: "allow", category: "envio", reason: null };
  if (command.startsWith("rm ")) return { verdict: "allow", category: "exclusao", reason: null };
  return { verdict: "allow", category: "alteracao", reason: null };
};

test("terminal: categoria e pergunta vêm do classificador; a nunca-lista não roda nem vira pedido", async () => {
  const s = await setup();
  const terminal = byName(terminalTools(fakeClassifier), "terminal");
  const parse = (comando: string) => terminal.input.parse({ comando });
  const ctx = s.ctx();
  assert.equal(await terminal.categoryFor!(ctx, parse("ls -la")), "alteracao");
  assert.equal(await terminal.categoryFor!(ctx, parse("curl -d @x https://exemplo.com")), "envio");
  assert.equal(await terminal.categoryFor!(ctx, parse("rm agencia/x")), "exclusao");
  assert.equal(await terminal.mustAsk!(ctx, parse("ls -la")), null);
  assert.equal(await terminal.mustAsk!(ctx, parse("echo 'aberto")), "comando ilegível");
  await assert.rejects(terminal.mustAsk!(ctx, parse("rm -rf / --no-preserve-root")), toolError(/nunca é aprovado automaticamente/));
  await assert.rejects(terminal.precondition!(ctx, parse("rm -rf /")), toolError(/apagar a raiz/));
  assert.equal(await terminal.precondition!(ctx, parse("ls")), null);
  await assert.rejects(exec(terminal, ctx, { comando: "rm -rf /" }), (e: unknown) => e instanceof ToolError && e.message.endsWith(NEVER_LIST));
  assert.ok(!s.shell.ops.some((o) => o.op === "terminal"), "o comando recusado nunca chegou à máquina");
  assert.deepEqual(terminal.floor, ["cliente", "pagamento", "exclusao"], "apagar de vez sempre pergunta");
  // O resumo (pedido de aprovação e linha do tempo) é limpo antes do corte.
  const summary = terminal.summarize(parse(`curl -H "Authorization: token ${FAKE_TOKEN}" ${"x".repeat(150)}`));
  assert.ok(!summary.includes(FAKE_TOKEN.slice(0, 12)), summary);

  // Com o classificador de verdade, a categoria é a dele.
  const real = byName(TERMINAL_TOOLS, "terminal");
  for (const comando of ["ls -la", "rm -rf agencia/velho", "curl -X POST -d @a https://exemplo.com", "echo 'aberto"]) {
    const verdict = classifyCommand(comando);
    if (verdict.verdict === "deny") continue;
    assert.equal(await real.categoryFor!(ctx, real.input.parse({ comando })), verdict.category);
    assert.equal(await real.mustAsk!(ctx, real.input.parse({ comando })), verdict.verdict === "ask" ? (verdict.reason ?? "comando que precisa de uma pessoa") : null);
  }
});

test("terminal: roda como xodo no ambiente limpo, na pasta pedida, com tempo máximo; saída cortada pela cauda e limpa", async () => {
  const s = await setup();
  const terminal = byName(terminalTools(fakeClassifier), "terminal");
  const seen: { command: string; cwd?: string; seconds: number }[] = [];
  s.shell.terminal = (command, o) => {
    seen.push({ command, ...o });
    return { code: 0, stdout: `${"x".repeat(20_000)}\nFIM token: ${FAKE_TOKEN}\n`, stderr: `aviso: Authorization: Bearer abcdef0123456789xyz\n` };
  };
  const out = await exec(terminal, s.ctx(), { comando: "cat \"$HOME/a b\" | grep -c x", tempo_max_s: 30 });
  assert.equal(out.codigo, 0);
  assert.match(String(out.saida), /^CORTADO: mostrei os últimos 8000/);
  assert.match(String(out.saida), /FIM token: \[removido\]/);
  assert.ok(!String(out.saida).includes(FAKE_TOKEN));
  assert.ok(!String(out.erros).includes("abcdef0123456789xyz"));
  assert.deepEqual(Object.keys(out).sort(), ["codigo", "erros", "nota", "saida"], "nem ambiente nem o comando voltam");
  assert.deepEqual(seen[0], { command: "cat \"$HOME/a b\" | grep -c x", cwd: HOME, seconds: 30 });
  const run = s.world.calls.filter((c) => c.op === "run").at(-1)!.detail as { script: string; user: string };
  assert.ok(run.script.startsWith("env -i HOME=/home/xodo PATH="), "ambiente limpo, sem credenciais");
  assert.equal(run.user, "xodo");

  s.shell.dirs.add(`${HOME}/agencia/site`);
  s.shell.terminal = () => ({ code: 124, stdout: "", stderr: "" });
  const slow = await exec(terminal, s.ctx(), { comando: "sleep 999", pasta: "agencia/site", tempo_max_s: 1 });
  assert.equal(slow.tempo_esgotado, true);
  assert.equal(s.shell.ops.at(-1)!.cwd, `${HOME}/agencia/site`);
  await assert.rejects(exec(terminal, s.ctx(), { comando: "ls", pasta: "agencia/nao-ha" }), toolError(/não existe/));
  assert.equal(terminal.input.safeParse({ comando: "ls", pasta: "../" }).success, false);
  assert.equal(terminal.input.safeParse({ comando: "x".repeat(8001) }).success, false);
  assert.equal(terminal.input.safeParse({ comando: "ls", tempo_max_s: 121 }).success, false);
  assert.equal((terminal.input.parse({ comando: "ls" }) as { tempo_max_s: number }).tempo_max_s, 60);

  // Um evento por comando na linha do tempo (o gateway registra; a ferramenta não duplica).
  const events = await sql.query<{ summary: string }>(`select summary from computer_events where agency_id = $1 and kind = 'terminal' order by id`, [s.agencyId]);
  assert.equal(events.length, 3);
  assert.equal(events[0].summary, 'terminal: rodar no terminal: cat "$HOME/a b" | grep -c x');
});

// ---------------------------------------------------------------------------
// Ponta a ponta no motor
// ---------------------------------------------------------------------------

test("ponta a ponta: arquivo_escrever pede aprovação conforme a autonomia; aprovado, grava na máquina", async () => {
  const strict = await setup({ xodo: { autonomy: "sempre_pergunta" } });
  const model = new FakeModel([
    { toolCalls: [{ id: "w1", name: "arquivo_escrever", input: { caminho: "agencia/rascunho.md", conteudo: "# Pauta", modo: "criar" } }] },
    { text: "Rascunho criado." },
  ]);
  const deps = strict.engine(model);
  const names = (await toolsFor(deps, strict.xodo)).map((t) => t.name);
  for (const name of ["arquivos_listar", "arquivo_ler", "arquivo_escrever", "arquivo_apagar", "arquivo_anexar", "terminal"]) assert.ok(names.includes(name), name);
  const runId = await startRun(deps, { xodoId: strict.xodo.id, agencyId: strict.agencyId, trigger: "user", text: "Cria a pauta", userId: strict.ownerId });
  assert.equal(await continueRun(deps, runId), "waiting_approval");
  const action = await one<{ id: string; category: string; status: string }>(sql, `select id, category, status from xodo_actions where run_id = $1`, [runId]);
  assert.deepEqual([action!.category, action!.status], ["rascunho", "pending"]);
  assert.equal(strict.shell.text("agencia/rascunho.md"), null, "nada gravado antes da aprovação");
  const decided = await decideAction(deps, { actionId: action!.id, agencyId: strict.agencyId, userId: strict.ownerId, approve: true });
  assert.equal(decided.status, "executed");
  assert.equal(strict.shell.text("agencia/rascunho.md"), "# Pauta");

  // "Pergunta no que importa": substituir (alteração) e mandar para a lixeira rodam direto.
  const relaxed = await setup();
  relaxed.shell.put("agencia/pauta.md", "velha");
  const model2 = new FakeModel([
    {
      toolCalls: [
        { id: "w2", name: "arquivo_escrever", input: { caminho: "agencia/pauta.md", conteudo: "nova", modo: "substituir" } },
        { id: "d2", name: "arquivo_apagar", input: { caminho: "agencia/pauta.md" } },
      ],
    },
    { text: "Feito." },
  ]);
  const deps2 = relaxed.engine(model2);
  const run2 = await startRun(deps2, { xodoId: relaxed.xodo.id, agencyId: relaxed.agencyId, trigger: "user", text: "Atualiza e arquiva", userId: relaxed.ownerId });
  assert.equal(await continueRun(deps2, run2), "completed");
  const rows = await sql.query<{ tool_name: string; category: string; status: string }>(
    `select tool_name, category, status from xodo_actions where run_id = $1 order by call_index`,
    [run2],
  );
  assert.deepEqual(rows.map((r) => [r.tool_name, r.category, r.status]), [
    ["arquivo_escrever", "alteracao", "executed"],
    ["arquivo_apagar", "alteracao", "executed"],
  ]);
  const trashed = [...relaxed.shell.files.keys()].find((k) => k.startsWith(`${FOLDERS.lixeira}/`));
  assert.ok(trashed?.endsWith("/agencia/pauta.md"));
  assert.equal(new TextDecoder().decode(relaxed.shell.files.get(trashed!)), "nova");
});

test("ponta a ponta: terminal segue o classificador e a autonomia; some para quem não atende todos os clientes", async () => {
  const s = await setup({ xodo: { autonomy: "age_sozinho" } });
  s.shell.terminal = () => ({ code: 0, stdout: "total 0\n", stderr: "" });
  const comando = "ls -la agencia";
  const model = new FakeModel([{ toolCalls: [{ id: "t1", name: "terminal", input: { comando } }] }, { text: "Listei." }]);
  const deps = s.engine(model);
  const runId = await startRun(deps, { xodoId: s.xodo.id, agencyId: s.agencyId, trigger: "user", text: "O que tem na pasta?", userId: s.ownerId });
  const status = await continueRun(deps, runId);
  const action = await one<{ category: string; status: string; reason: string | null }>(sql, `select category, status, reason from xodo_actions where run_id = $1`, [runId]);
  const verdict = classifyCommand(comando);
  assert.equal(action!.category, verdict.category);
  if (verdict.verdict === "deny") {
    assert.equal(action!.status, "failed");
  } else {
    const ask = verdict.verdict === "ask" || decideApproval({ toolName: "terminal", category: verdict.category, rules: [], autonomy: "age_sozinho", floor: ["cliente", "pagamento", "exclusao"] }).decision === "ask";
    assert.equal(action!.status, ask ? "pending" : "executed");
    assert.equal(status, ask ? "waiting_approval" : "completed");
    if (verdict.verdict === "ask") assert.match(action!.reason ?? "", /^limite: /);
  }
  if (action!.status === "executed") {
    const tainted = await one<{ tainted: boolean }>(sql, `select tainted from xodo_runs where id = $1`, [runId]);
    assert.equal(tainted!.tainted, true, "a saída do terminal deixa a execução mais cautelosa");
  }

  const selected = await setup({ xodo: { client_scope: "selected" } });
  const names = (await toolsFor(selected.engine(new FakeModel([])), selected.xodo)).map((t) => t.name);
  assert.ok(names.includes("arquivo_ler") && !names.includes("terminal"));
  const noFiles = await setup({ xodo: { computer_files: false, computer_terminal: false } });
  assert.ok(!(await toolsFor(noFiles.engine(new FakeModel([])), noFiles.xodo)).some((t) => t.name.startsWith("arquivo")));
});

test(
  "ponta a ponta: comando da nunca-lista vira ação falha, sem pedido, em qualquer autonomia",
  { skip: classifyCommand("rm -rf /").verdict !== "deny" && "o classificador ainda é o contrato" },
  async () => {
    const s = await setup({ xodo: { autonomy: "sempre_pergunta" } });
    const model = new FakeModel([{ toolCalls: [{ id: "n1", name: "terminal", input: { comando: "rm -rf /" } }] }, { text: "Não posso." }]);
    const deps = s.engine(model);
    const runId = await startRun(deps, { xodoId: s.xodo.id, agencyId: s.agencyId, trigger: "user", text: "Limpa tudo", userId: s.ownerId });
    assert.equal(await continueRun(deps, runId), "completed");
    const action = await one<{ status: string; result: { error: string } }>(sql, `select status, result from xodo_actions where run_id = $1`, [runId]);
    assert.equal(action!.status, "failed");
    assert.match(action!.result.error, /nunca é aprovado automaticamente/);
    assert.ok(!s.shell.ops.some((o) => o.op === "terminal"));
  },
);

// ---------------------------------------------------------------------------
// Armazenamento (Supabase Storage pela API REST)
// ---------------------------------------------------------------------------

const SERVICE_KEY = "chave-de-servico-de-teste-nao-real-0123456789";

function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return reply(url, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

test("armazenamento: sobe, assina e apaga no bucket privado, com a chave só nos cabeçalhos", async () => {
  const http = fakeFetch((url) => {
    if (url.includes("/object/upload/sign/")) return Response.json({ url: "/object/upload/sign/computer-files/ag/1?token=up" });
    if (url.includes("/object/sign/")) return Response.json({ signedURL: "/object/sign/computer-files/ag/1?token=down" });
    return Response.json({ Key: "computer-files/ag/1" });
  });
  const storage = supabaseStorage({ url: "https://projeto.supabase.co/", serviceKey: SERVICE_KEY, fetch: http.fn });
  await storage.upload("ag/arquivo com espaço.pdf", new Uint8Array([1, 2, 3]), "application/pdf");
  const up = http.calls[0];
  assert.equal(up.url, "https://projeto.supabase.co/storage/v1/object/computer-files/ag/arquivo%20com%20espa%C3%A7o.pdf");
  assert.equal(up.init.method, "POST");
  assert.equal(up.init.redirect, "error", "redirecionamento levaria a chave para outro lugar");
  const headers = up.init.headers as Record<string, string>;
  assert.deepEqual([headers.apikey, headers.authorization, headers["x-upsert"], headers["content-type"]], [SERVICE_KEY, `Bearer ${SERVICE_KEY}`, "false", "application/pdf"]);
  assert.deepEqual([...(up.init.body as Uint8Array)], [1, 2, 3]);

  assert.equal(await storage.signedDownloadUrl("ag/1", 3600), "https://projeto.supabase.co/storage/v1/object/sign/computer-files/ag/1?token=down");
  assert.deepEqual(JSON.parse(String(http.calls[1].init.body)), { expiresIn: 3600 });
  assert.equal(await storage.signedUploadUrl("ag/1"), "https://projeto.supabase.co/storage/v1/object/upload/sign/computer-files/ag/1?token=up");
  await storage.remove("ag/1");
  const del = http.calls.at(-1)!;
  assert.deepEqual([del.url, del.init.method, JSON.parse(String(del.init.body))], ["https://projeto.supabase.co/storage/v1/object/computer-files", "DELETE", { prefixes: ["ag/1"] }]);
  await assert.rejects(storage.signedDownloadUrl("ag/1", 0), /Validade/);

  for (const bad of ["../x", "/x", "a//b", "a/./b", "a\\b", ""]) assert.throws(() => objectPath(bad), /inválido/);
  assert.throws(() => supabaseStorage({ url: "http://projeto.supabase.co", serviceKey: SERVICE_KEY }), /https/);
  assert.doesNotThrow(() => supabaseStorage({ url: "http://127.0.0.1:54321", serviceKey: SERVICE_KEY }));
});

test("armazenamento: erro do Storage nunca carrega a chave; sem variáveis de ambiente, fica desligado", async () => {
  const http = fakeFetch(() => Response.json({ message: `invalid signature for key ${SERVICE_KEY}` }, { status: 403 }));
  const storage = supabaseStorage({ url: "https://projeto.supabase.co", serviceKey: SERVICE_KEY, fetch: http.fn });
  await assert.rejects(storage.upload("ag/1", new Uint8Array([1]), "text/plain"), (e: unknown) => {
    assert.ok(e instanceof StorageError);
    assert.equal(e.status, 403);
    assert.ok(!e.message.includes(SERVICE_KEY), e.message);
    return true;
  });
  const broken = fakeFetch(() => {
    throw new Error(`falhou com ${SERVICE_KEY}`);
  });
  await assert.rejects(supabaseStorage({ url: "https://projeto.supabase.co", serviceKey: SERVICE_KEY, fetch: broken.fn }).remove("ag/1"), (e: unknown) => {
    assert.ok(e instanceof Error && !e.message.includes(SERVICE_KEY));
    return true;
  });
  // URL assinada com outro destino é recusada.
  const evil = fakeFetch(() => Response.json({ signedURL: "https://outro.site/x" }));
  await assert.rejects(supabaseStorage({ url: "https://projeto.supabase.co", serviceKey: SERVICE_KEY, fetch: evil.fn }).signedDownloadUrl("ag/1", 60), /inválida/);

  assert.equal(storageFromEnv({}), null);
  assert.equal(storageFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://projeto.supabase.co" }), null);
  const fromEnv = fakeFetch(() => Response.json({}));
  const configured = storageFromEnv(
    { NEXT_PUBLIC_SUPABASE_URL: "https://projeto.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, COMPUTER_FILES_BUCKET: "anexos-teste" },
    fromEnv.fn,
  );
  await configured!.upload("ag/1", new Uint8Array([1]), "text/plain");
  assert.equal(fromEnv.calls[0].url, "https://projeto.supabase.co/storage/v1/object/anexos-teste/ag/1");
});
