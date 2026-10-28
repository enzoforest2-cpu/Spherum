import { refreshFx, runDueRoutines, sweep } from "../src/xodos";
import { processDueCaptures } from "../src/xodos/memory/capture";
import { pruneMemoryHistory, tidyDueMemories } from "../src/xodos/memory/upkeep";
import { continueRun, resumeRun, type EngineDeps } from "../src/xodos/runner";

/**
 * O trabalho em segundo plano do app. No Spherum isso era o cron na nuvem; aqui é o próprio
 * programa, enquanto ele estiver aberto:
 *  - leva cada execução até o fim (o motor trabalha em fatias de alguns minutos);
 *  - a cada minuto: vence pedidos de aprovação antigos, roda as rotinas da hora, guarda na
 *    memória o que as conversas ensinaram e, uma vez por dia, atualiza o dólar e arruma a memória.
 */
export class Worker {
  private running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastDaily = "";
  /** Avisado a cada mudança de execução, para a tela atualizar na hora. */
  onChange: (runId: string) => void = () => {};

  constructor(private deps: EngineDeps) {}

  /** Continua a execução até ela parar (terminou, espera você ou falhou). Uma por vez por execução. */
  drive(runId: string): Promise<void> {
    const existing = this.running.get(runId);
    if (existing) return existing;
    const task = (async () => {
      try {
        for (let i = 0; i < 100; i++) {
          const status = await continueRun(this.deps, runId);
          this.onChange(runId);
          if (status !== "running") return;
        }
      } catch (error) {
        console.error("[xodos] a execução parou com erro", runId, error);
      } finally {
        this.running.delete(runId);
        this.onChange(runId);
      }
    })();
    this.running.set(runId, task);
    return task;
  }

  /** Depois de você aprovar ou negar: retoma a execução, se ela estava esperando só isso. */
  async afterDecision(runId: string) {
    try {
      const status = await resumeRun(this.deps, runId);
      this.onChange(runId);
      if (status === "running") await this.drive(runId);
    } catch (error) {
      console.error("[xodos] a retomada falhou", runId, error);
    }
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 60_000);
    setTimeout(() => void this.tick(), 3_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    const deadline = Date.now() + 50_000;
    const step = async <T>(name: string, fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (error) {
        console.error(`[agendador] ${name} falhou`, error);
        return null;
      }
    };
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (this.lastDaily !== today) {
        await step("cotação do dólar", () => refreshFx(this.deps.sql, new Date()));
        await step("arrumar a memória", () => tidyDueMemories(this.deps, { deadline }));
        await step("histórico da memória", () => pruneMemoryHistory(this.deps.sql, new Date()));
        this.lastDaily = today;
      }
      const swept = await step("pedidos vencidos", () => sweep(this.deps, { deadline }));
      if (swept) this.onChange("*");
      const routines = await step("rotinas", () => runDueRoutines(this.deps, 5, { deadline }));
      for (const r of routines ?? []) {
        if (r.runId) {
          this.onChange(r.runId);
          if (r.status === "running") void this.drive(r.runId);
        }
      }
      await step("memória das conversas", () => processDueCaptures(this.deps, { deadline }));
    } finally {
      this.ticking = false;
    }
  }
}
