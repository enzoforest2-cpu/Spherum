import { z } from "zod";
import type { ComputerDeps } from "../computer/lifecycle";
import type { AppAccess } from "../integrations/access";
import type { AppId } from "../integrations/apps";
import { IntegrationError } from "../integrations/http";
import { notify } from "./budget";
import { one, type Sql } from "./db";
import type { Category } from "./policy";
import type { Xodo } from "./types";
import { FILE_TOOLS } from "../local/files";
import { WEB_TOOLS } from "../local/web";

/**
 * Ferramentas dos Xodós. Cada uma declara a categoria (que define a aprovação) e valida a
 * entrada com zod. As do dia a dia (internet e pasta de arquivos) ficam em src/local.
 */

export type ToolContext = {
  sql: Sql;
  xodo: Xodo;
  runId: string;
  now: Date;
  /** O que disparou a execução (user, channel, routine, event), quando conhecido. */
  trigger?: string;
  /** A execução já leu conteúdo de fora (página, arquivo baixado, terminal): o que ela escreve na memória pede aprovação. */
  tainted?: boolean;
  /** Máquina da agência (computador na nuvem); nula quando o motor roda sem ela. */
  computer?: ComputerDeps | null;
  /** Precondição guardada no pedido aprovado (só quando a ação passou por aprovação). */
  precondition?: Record<string, unknown> | null;
  /** Acesso às conexões da agência; nulo quando o motor roda sem integrações. */
  apps: AppAccess | null;
};

export type ToolDef<I = unknown> = {
  name: string;
  description: string;
  category: Category;
  /** App(s) de onde a ferramenta vem; só aparece para xodós com algum deles em "Pode mexer em". */
  app?: AppId | AppId[];
  input: z.ZodType<I>;
  /** Esquema JSON pronto (ferramentas de servidores MCP); senão, sai do zod. */
  jsonSchema?: Record<string, unknown>;
  /** Frase curta mostrada no pedido de aprovação. */
  summarize(input: I): string;
  execute(ctx: ToolContext, input: I): Promise<unknown>;
  /**
   * Motivo para pedir aprovação mesmo quando a autonomia deixaria rodar (ex.: mudança de verba
   * acima do limite do xodó). Nulo: segue a política normal.
   */
  mustAsk?(ctx: ToolContext, input: I): Promise<string | null>;
  /**
   * Categoria que depende do destino (ex.: mensagem num canal interno do Slack é "equipe"; num
   * canal compartilhado com outra empresa, "envio"). Se falhar, vale `category`.
   */
  categoryFor?(ctx: ToolContext, input: I): Promise<Category>;
  /** Limpa a entrada antes de ser guardada e executada (ex.: dados sensíveis numa nota de memória). */
  scrub?(input: I): I;
  /** Ferramenta de memória: some quando a memória do xodó está desligada. */
  memory?: boolean;
  /** Categorias que sempre perguntam nesta ferramenta, qualquer que seja a autonomia (piso). */
  floor?: Category[];
  /** Lê conteúdo de fora (página, arquivo baixado): depois dela, a execução segue mais cautelosa. */
  taints?: boolean;
  /** Encerra o turno do xodó esperando uma pessoa (ex.: pedir o controle do computador). */
  endsTurn?: "takeover";
  /** Site da ação (host), para regras "sempre permitir" por site e para a precondição. */
  siteOf?(ctx: ToolContext, input: I): Promise<string | null>;
  /**
   * O que precisa continuar igual para a ação aprovada rodar (ex.: url e rótulo do botão).
   * Fica guardado no pedido; na execução chega em ctx.precondition.
   */
  precondition?(ctx: ToolContext, input: I): Promise<Record<string, unknown> | null>;
  /** Validade do pedido de aprovação (padrão: 24 horas; ações de tela, 15 minutos). */
  approvalTtlMs?: number;
  /** Parte do computador na nuvem que a ferramenta usa (só aparece se ela estiver ligada no xodó). */
  computerPart?: "browser" | "files" | "terminal" | "control";
};

export { ToolError } from "./tool-error";
import { ToolError } from "./tool-error";

/** Acesso a um app dentro de uma ferramenta, com os erros de integração virando ToolError. */
export async function openApp(ctx: ToolContext, app: AppId) {
  if (!ctx.apps) throw new ToolError("As integrações não estão disponíveis agora.");
  try {
    return await ctx.apps.use(app);
  } catch (error) {
    if (error instanceof IntegrationError) throw new ToolError(error.message);
    throw error;
  }
}

/** Roda uma chamada a um app e transforma erro do provedor em ToolError com a mensagem dele. */
export async function appCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof IntegrationError) throw new ToolError(error.message);
    throw error;
  }
}

function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

export async function assertClient(ctx: ToolContext, id: string): Promise<{ id: string; name: string }> {
  const client = await one<{ id: string; name: string }>(
    ctx.sql,
    `select c.id, c.name from clients c
      where c.id = $1 and c.agency_id = $2
        and ($3 = 'all' or exists (select 1 from xodo_clients xc where xc.xodo_id = $4 and xc.client_id = c.id))`,
    [id, ctx.xodo.agency_id, ctx.xodo.client_scope, ctx.xodo.id],
  );
  if (!client) throw new ToolError("Cliente não encontrado ou fora do alcance deste xodó.");
  return client;
}

export const TOOLS: ToolDef[] = [
  ...WEB_TOOLS,
  ...FILE_TOOLS,
  tool({
    name: "me_avisar",
    description: "Manda um aviso para você no app (aparece no sino e, se ligado, no WhatsApp). Use para lembretes e para avisar que terminou algo.",
    category: "equipe",
    input: z.object({ titulo: z.string().min(1).max(120), mensagem: z.string().max(2000).default("") }),
    summarize: (i) => `avisar você: ${i.titulo}`,
    async execute(ctx, i) {
      await notify(ctx.sql, ctx.xodo.agency_id, {
        kind: "xodo_message",
        title: `${ctx.xodo.name}: ${i.titulo}`,
        body: i.mensagem,
        data: { xodo_id: ctx.xodo.id, run_id: ctx.runId },
      });
      return { enviado: true };
    },
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Esquema JSON enviado ao modelo. Tira o $schema e as regex longas que o zod gera para
 * data e UUID (o "format" já diz o mesmo): custam tokens a cada passo e o Gemini recusa
 * parte delas. A validação de verdade continua no zod, no servidor.
 */
export function toolJsonSchema(def: ToolDef): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const entries = Object.entries(node as Record<string, unknown>).filter(
      ([key]) => key !== "$schema" && !(key === "pattern" && "format" in (node as object)),
    );
    return Object.fromEntries(entries.map(([key, value]) => [key, strip(value)]));
  };
  return strip(def.jsonSchema ?? z.toJSONSchema(def.input, { io: "input" })) as Record<string, unknown>;
}
