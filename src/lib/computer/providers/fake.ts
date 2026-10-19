import { randomUUID } from "node:crypto";
import { SandboxGone, type ProviderFactory, type RunResult, type SandboxProvider } from "../provider";

/**
 * Provedor falso para os testes: máquinas e arquivos em memória e um tratador de comandos
 * que o teste define. Registra cada chamada para as asserções.
 */

export type FakeMachine = { ref: string; state: "running" | "paused" | "destroyed"; files: Map<string, Uint8Array>; idleMs: number };

export type FakeWorld = {
  machines: Map<string, FakeMachine>;
  calls: { op: string; ref?: string; detail?: unknown }[];
  /** Resposta aos comandos (padrão: código 0 e saída vazia). */
  onRun: (script: string, o: { user: "root" | "xodo"; cwd?: string; stdin?: string }) => RunResult | Promise<RunResult>;
  /** Faz a próxima chamada a uma máquina dizer que ela sumiu. */
  vanish(ref: string): void;
};

export function fakeWorld(): FakeWorld {
  const world: FakeWorld = {
    machines: new Map(),
    calls: [],
    onRun: () => ({ code: 0, stdout: "", stderr: "" }),
    vanish(ref) {
      world.machines.delete(ref);
    },
  };
  return world;
}

export function fakeProvider(world: FakeWorld): ProviderFactory {
  return () => {
    const machine = (ref: string) => {
      const m = world.machines.get(ref);
      if (!m || m.state === "destroyed") throw new SandboxGone(`sandbox ${ref} not found`);
      return m;
    };
    const p: SandboxProvider = {
      id: "fake",
      async create(o) {
        const ref = `fake-${randomUUID().slice(0, 8)}`;
        world.machines.set(ref, { ref, state: "running", files: new Map(), idleMs: o.idleMs });
        world.calls.push({ op: "create", ref, detail: o });
        return { ref };
      },
      async resume(ref, idleMs) {
        const m = machine(ref);
        m.state = "running";
        m.idleMs = idleMs;
        world.calls.push({ op: "resume", ref });
      },
      async pause(ref) {
        machine(ref).state = "paused";
        world.calls.push({ op: "pause", ref });
      },
      async destroy(ref) {
        const m = world.machines.get(ref);
        if (m) m.state = "destroyed";
        world.calls.push({ op: "destroy", ref });
      },
      async extend(ref, idleMs) {
        machine(ref).idleMs = idleMs;
        world.calls.push({ op: "extend", ref });
      },
      async run(ref, o) {
        const m = machine(ref);
        if (m.state !== "running") throw new Error("máquina pausada");
        world.calls.push({ op: "run", ref, detail: { script: o.script, user: o.user, cwd: o.cwd } });
        return world.onRun(o.script, o);
      },
      async read(ref, path, maxBytes) {
        const data = machine(ref).files.get(path);
        if (!data) throw new Error(`No such file: ${path}`);
        world.calls.push({ op: "read", ref, detail: path });
        return data.slice(0, maxBytes);
      },
      async write(ref, path, data) {
        machine(ref).files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
        world.calls.push({ op: "write", ref, detail: path });
      },
      async publicUrl(ref, port) {
        machine(ref);
        return `https://${port}-${ref}.fake.sandbox`;
      },
      isGone: (error) => error instanceof SandboxGone,
    };
    return p;
  };
}
