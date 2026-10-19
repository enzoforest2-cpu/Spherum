import { one } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { redactDeep } from "../xodos/redact";
import { ToolError, type ToolContext, type ToolDef } from "../xodos/tools";
import { ensureRunning, finishEvent, loadComputer, logEvent, safeError, type ComputerDeps, type RunningComputer } from "./lifecycle";

/**
 * Caminho único de toda ferramenta do computador (o audited() do OpenDots com as regras do
 * OpenMausBot), nesta ordem:
 *  1. computador ligado para o xodó e a parte certa ligada (navegador, arquivos, terminal);
 *  2. pessoa no controle: tudo para, para todos os xodós (ela pode estar digitando uma senha);
 *     a ação é recusada, nunca enfileirada;
 *  3. máquina ligada (cria, retoma ou estende; respeita o teto de horas);
 *  4. tela: uma execução por vez (lease de 2 minutos renovado a cada ação);
 *  5. evento "pending" na linha do tempo, execução, evento fechado;
 *  6. resultado limpo de dados sensíveis antes de voltar.
 * A aprovação (categoria, piso, regra de site) acontece antes, no motor; um pedido aprovado
 * depois passa por este mesmo caminho.
 */

export type ComputerPart = "browser" | "files" | "terminal" | "control";

export type ComputerCall = {
  ctx: ToolContext;
  deps: ComputerDeps;
  machine: RunningComputer;
  eventId: string;
};

/** Categorias que sempre perguntam nas ferramentas do computador (pagar, apagar de vez, cliente). */
export const COMPUTER_FLOOR = ["cliente", "pagamento", "exclusao"] as const;

export const SCREEN_LEASE_MS = 2 * 60 * 1000;

export type ComputerToolDef<I> = Omit<ToolDef<I>, "execute"> & {
  part: ComputerPart;
  /** Usa a tela (navegador e ações de tela): uma execução por vez. */
  screen?: boolean;
  run(c: ComputerCall, input: I): Promise<unknown>;
};

const PART_LABEL: Record<ComputerPart, string> = { browser: "navegador", files: "arquivos", terminal: "terminal", control: "computador" };

/** O xodó pode usar esta parte do computador? Devolve o motivo quando não pode. */
export function partBlocked(xodo: ToolContext["xodo"], part: ComputerPart): string | null {
  if (xodo.computer_mode !== "cloud") return "O computador na nuvem está desligado para este xodó.";
  if (part === "browser" && !xodo.computer_browser) return "O navegador do computador está desligado para este xodó.";
  if (part === "files" && !xodo.computer_files) return "Os arquivos do computador estão desligados para este xodó.";
  if (part === "terminal") {
    if (!xodo.computer_terminal) return "O terminal do computador está desligado para este xodó.";
    // O terminal enxerga tudo da máquina (inclusive os logins de todos os clientes).
    if (xodo.client_scope !== "all") return "O terminal só pode ser usado por xodós que atendem todos os clientes.";
  }
  if (part === "control" && !(xodo.computer_browser || xodo.computer_files || xodo.computer_terminal)) {
    return "O computador na nuvem está desligado para este xodó.";
  }
  return null;
}

/** Pega (ou renova) a tela para esta execução; recusa se outra execução está com ela. */
async function takeScreen(c: { ctx: ToolContext; machine: RunningComputer }, now: Date) {
  const { ctx, machine } = c;
  const row = await one<{ id: string }>(
    ctx.sql,
    `update computers set screen_run_id = $2, screen_expires_at = $3::timestamptz, screen_fence = screen_fence + 1
      where id = $1 and (screen_run_id is null or screen_run_id = $2 or screen_expires_at <= $4::timestamptz) returning id`,
    [machine.computer.id, ctx.runId, new Date(now.getTime() + SCREEN_LEASE_MS).toISOString(), now.toISOString()],
  );
  if (row) return;
  const holder = await one<{ name: string }>(
    ctx.sql,
    `select x.name from computers c join xodo_runs r on r.id = c.screen_run_id join xodos x on x.id = r.xodo_id where c.id = $1`,
    [machine.computer.id],
  );
  throw new ToolError(`A tela do computador está com ${holder?.name ?? "outro xodó"} agora; arquivos e terminal continuam disponíveis.`);
}

const controlHeld = (row: { control_user_id: string | null; control_expires_at: Date | string | null }, now: Date) =>
  Boolean(row.control_user_id && row.control_expires_at && new Date(row.control_expires_at).getTime() > now.getTime());

export const CONTROL_HELD = "Uma pessoa da equipe está usando o computador agora. Espere ela devolver o controle.";

/** Transforma a definição numa ferramenta do motor, com o caminho do gateway em volta. */
export function computerTool<I>(def: ComputerToolDef<I>): ToolDef {
  const { run, part, screen, ...rest } = def;
  const wrapped: ToolDef<I> = {
    ...rest,
    floor: [...COMPUTER_FLOOR, ...(rest.floor ?? [])],
    async execute(ctx, input) {
      const deps = ctx.computer;
      if (!deps) throw new ToolError("O computador não está disponível agora.");
      const blocked = partBlocked(ctx.xodo, part);
      if (blocked) throw new ToolError(blocked);
      const now = ctx.now;
      const current = await loadComputer(ctx.sql, ctx.xodo.agency_id);
      if (!current) throw new ToolError("O computador da agência ainda não foi configurado.");
      if (controlHeld(current, now)) {
        await logEvent(ctx.sql, { agencyId: ctx.xodo.agency_id, computerId: current.id, kind: def.name, status: "denied", summary: "pessoa no controle", xodoId: ctx.xodo.id, runId: ctx.runId });
        throw new ToolError(CONTROL_HELD);
      }
      let machine: RunningComputer;
      try {
        machine = await ensureRunning(deps, ctx.xodo.agency_id);
      } catch (error) {
        if (error instanceof XodoError) throw new ToolError(error.message);
        throw error;
      }
      if (screen) await takeScreen({ ctx, machine }, now);
      const eventId = await logEvent(ctx.sql, {
        agencyId: ctx.xodo.agency_id,
        computerId: machine.computer.id,
        kind: def.name,
        status: "pending",
        summary: `${PART_LABEL[part]}: ${def.summarize(input)}`,
        xodoId: ctx.xodo.id,
        runId: ctx.runId,
      });
      try {
        const result = await run({ ctx, deps, machine, eventId }, input);
        // Se uma pessoa assumiu durante a ação, o resultado avisa (o xodó olha antes de seguir).
        const after = await loadComputer(ctx.sql, ctx.xodo.agency_id);
        await finishEvent(ctx.sql, eventId, "succeeded");
        const clean = redactDeep(result).value;
        return after && controlHeld(after, ctx.now) ? { resultado: clean, aviso: CONTROL_HELD } : clean;
      } catch (error) {
        await finishEvent(ctx.sql, eventId, "failed", safeError(error));
        if (error instanceof ToolError) throw error;
        if (error instanceof XodoError) throw new ToolError(error.message);
        throw new ToolError(`O computador não conseguiu fazer isso: ${safeError(error)}`);
      }
    },
  };
  return wrapped as unknown as ToolDef;
}
