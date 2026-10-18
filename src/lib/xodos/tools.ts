import { z } from "zod";
import type { AppAccess } from "../integrations/access";
import type { AppId } from "../integrations/apps";
import { IntegrationError } from "../integrations/http";
import { notify } from "./budget";
import { num, one, type Sql } from "./db";
import { saveMemory } from "./memory";
import type { Category } from "./policy";
import type { Xodo } from "./types";

/**
 * Ferramentas dos Xodós. Cada uma declara a categoria (que define a aprovação), valida a
 * entrada com zod e só enxerga dados da própria agência e dos clientes liberados ao xodó.
 */

export type ToolContext = {
  sql: Sql;
  xodo: Xodo;
  runId: string;
  now: Date;
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
};

/** Erro esperado: volta para o modelo como resultado com erro, sem derrubar a execução. */
export class ToolError extends Error {}

/** Acesso a um app dentro de uma ferramenta, com os erros de integração virando ToolError. */
export async function useApp(ctx: ToolContext, app: AppId) {
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

const day = z.iso.date();
const clientId = z.uuid();

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

function assertRange(start: string, end: string) {
  if (end < start) throw new ToolError("A data final vem antes da inicial.");
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (days > 366) throw new ToolError("Período máximo de 366 dias.");
}

type Totals = {
  spend_cents: unknown;
  impressions: unknown;
  clicks: unknown;
  leads: unknown;
  conversions: unknown;
  revenue_cents: unknown;
};

function kpis(row: Totals) {
  const spend = num(row.spend_cents) / 100;
  const revenue = num(row.revenue_cents) / 100;
  const impressions = num(row.impressions);
  const clicks = num(row.clicks);
  const leads = num(row.leads);
  const ratio = (a: number, b: number, digits = 2) => (b > 0 ? Number((a / b).toFixed(digits)) : null);
  return {
    investimento_brl: Number(spend.toFixed(2)),
    receita_brl: Number(revenue.toFixed(2)),
    impressoes: impressions,
    cliques: clicks,
    leads,
    conversoes: num(row.conversions),
    ctr_pct: ratio(clicks * 100, impressions),
    cpc_brl: ratio(spend, clicks),
    cpl_brl: ratio(spend, leads),
    roas: ratio(revenue, spend),
  };
}

const SUMS = `coalesce(sum(spend_cents), 0) as spend_cents, coalesce(sum(impressions), 0) as impressions,
  coalesce(sum(clicks), 0) as clicks, coalesce(sum(leads), 0) as leads,
  coalesce(sum(conversions), 0) as conversions, coalesce(sum(revenue_cents), 0) as revenue_cents`;

async function totals(ctx: ToolContext, client: string, start: string, end: string) {
  const row = await one<Totals>(
    ctx.sql,
    `select ${SUMS} from metrics_daily where agency_id = $1 and client_id = $2 and day between $3::date and $4::date`,
    [ctx.xodo.agency_id, client, start, end],
  );
  return kpis(row!);
}

const GROUPS = {
  total: { select: "", group: "", order: "" },
  dia: { select: "day::text as dia,", group: "group by day", order: "order by day" },
  campanha: {
    select: "platform as plataforma, campaign_id, max(campaign_name) as campanha,",
    group: "group by platform, campaign_id",
    order: "order by sum(spend_cents) desc",
  },
  plataforma: { select: "platform as plataforma,", group: "group by platform", order: "order by sum(spend_cents) desc" },
} as const;

export const TOOLS: ToolDef[] = [
  tool({
    name: "listar_clientes",
    description: "Lista os clientes da agência que você pode atender, com id e nome.",
    category: "leitura",
    input: z.object({}),
    summarize: () => "listar clientes",
    async execute(ctx) {
      return ctx.sql.query(
        `select c.id, c.name as nome from clients c
          where c.agency_id = $1
            and ($2 = 'all' or exists (select 1 from xodo_clients xc where xc.xodo_id = $3 and xc.client_id = c.id))
          order by c.name limit 200`,
        [ctx.xodo.agency_id, ctx.xodo.client_scope, ctx.xodo.id],
      );
    },
  }),
  tool({
    name: "consultar_metricas",
    description:
      "Métricas de mídia paga de um cliente num período (investimento, impressões, cliques, leads, conversões, receita, CTR, CPC, CPL e ROAS). Valores em reais.",
    category: "leitura",
    input: z.object({
      client_id: clientId,
      inicio: day.describe("AAAA-MM-DD"),
      fim: day.describe("AAAA-MM-DD"),
      agrupar_por: z.enum(["total", "dia", "campanha", "plataforma"]).default("total"),
      plataforma: z.enum(["meta", "google", "tiktok", "linkedin", "ga4", "other"]).optional(),
    }),
    summarize: (i) => `consultar métricas de ${i.inicio} a ${i.fim}`,
    async execute(ctx, i) {
      const client = await assertClient(ctx, i.client_id);
      assertRange(i.inicio, i.fim);
      const g = GROUPS[i.agrupar_por];
      const params: unknown[] = [ctx.xodo.agency_id, client.id, i.inicio, i.fim];
      let filter = "";
      if (i.plataforma) {
        params.push(i.plataforma);
        filter = `and platform = $${params.length}`;
      }
      const rows = await ctx.sql.query<Totals & Record<string, unknown>>(
        `select ${g.select} ${SUMS} from metrics_daily
          where agency_id = $1 and client_id = $2 and day between $3::date and $4::date ${filter}
          ${g.group} ${g.order} limit 200`,
        params,
      );
      return {
        cliente: client.name,
        periodo: { inicio: i.inicio, fim: i.fim },
        linhas: rows.map((row) => {
          const { spend_cents, impressions, clicks, leads, conversions, revenue_cents, ...keys } = row;
          return { ...keys, ...kpis({ spend_cents, impressions, clicks, leads, conversions, revenue_cents }) };
        }),
      };
    },
  }),
  tool({
    name: "comparar_periodos",
    description: "Compara os totais de um cliente entre dois períodos e mostra a variação percentual de cada métrica.",
    category: "leitura",
    input: z.object({
      client_id: clientId,
      atual: z.object({ inicio: day, fim: day }),
      anterior: z.object({ inicio: day, fim: day }),
    }),
    summarize: () => "comparar períodos",
    async execute(ctx, i) {
      const client = await assertClient(ctx, i.client_id);
      assertRange(i.atual.inicio, i.atual.fim);
      assertRange(i.anterior.inicio, i.anterior.fim);
      const now = await totals(ctx, client.id, i.atual.inicio, i.atual.fim);
      const before = await totals(ctx, client.id, i.anterior.inicio, i.anterior.fim);
      const variacao_pct: Record<string, number | null> = {};
      for (const key of Object.keys(now) as (keyof typeof now)[]) {
        const a = now[key];
        const b = before[key];
        variacao_pct[key] = a === null || b === null || b === 0 ? null : Number((((a - b) / b) * 100).toFixed(1));
      }
      return { cliente: client.name, atual: now, anterior: before, variacao_pct };
    },
  }),
  tool({
    name: "consultar_analytics",
    description:
      "Dados do Google Analytics 4 de um cliente num período: sessões, usuários, eventos principais e receita (R$), no total, por dia ou por canal.",
    category: "leitura",
    input: z.object({
      client_id: clientId,
      inicio: day.describe("AAAA-MM-DD"),
      fim: day.describe("AAAA-MM-DD"),
      agrupar_por: z.enum(["total", "dia", "canal"]).default("total"),
    }),
    summarize: (i) => `consultar o GA4 de ${i.inicio} a ${i.fim}`,
    async execute(ctx, i) {
      const client = await assertClient(ctx, i.client_id);
      assertRange(i.inicio, i.fim);
      const group = { total: ["", "", ""], dia: ["day::text as dia,", "group by day", "order by day"], canal: ["channel as canal,", "group by channel", "order by sum(sessions) desc"] }[i.agrupar_por];
      const rows = await ctx.sql.query<Record<string, unknown>>(
        `select ${group[0]} coalesce(sum(sessions), 0) as sessoes, coalesce(sum(users), 0) as usuarios,
                coalesce(sum(key_events), 0) as eventos_principais, coalesce(sum(revenue_cents), 0) as receita_cents
           from analytics_daily where agency_id = $1 and client_id = $2 and day between $3::date and $4::date
           ${group[1]} ${group[2]} limit 400`,
        [ctx.xodo.agency_id, client.id, i.inicio, i.fim],
      );
      return {
        cliente: client.name,
        periodo: { inicio: i.inicio, fim: i.fim },
        linhas: rows.map(({ receita_cents, sessoes, usuarios, eventos_principais, ...keys }) => ({
          ...keys,
          sessoes: num(sessoes),
          usuarios: num(usuarios),
          eventos_principais: num(eventos_principais),
          receita_brl: Number((num(receita_cents) / 100).toFixed(2)),
        })),
      };
    },
  }),
  tool({
    name: "listar_relatorios",
    description: "Lista os relatórios recentes (rascunhos e publicados), opcionalmente de um cliente.",
    category: "leitura",
    input: z.object({ client_id: clientId.optional(), status: z.enum(["draft", "published", "archived"]).optional() }),
    summarize: () => "listar relatórios",
    async execute(ctx, i) {
      if (i.client_id) await assertClient(ctx, i.client_id);
      return ctx.sql.query(
        `select r.id, r.title as titulo, c.name as cliente, r.period_start::text as inicio, r.period_end::text as fim,
                r.status, r.created_at::text as criado_em
           from reports r join clients c on c.id = r.client_id
          where r.agency_id = $1
            and ($2::uuid is null or r.client_id = $2::uuid)
            and ($3::text is null or r.status = $3::text)
            and ($4 = 'all' or exists (select 1 from xodo_clients xc where xc.xodo_id = $5 and xc.client_id = r.client_id))
          order by r.created_at desc limit 20`,
        [ctx.xodo.agency_id, i.client_id ?? null, i.status ?? null, ctx.xodo.client_scope, ctx.xodo.id],
      );
    },
  }),
  tool({
    name: "ler_relatorio",
    description: "Lê o conteúdo completo de um relatório.",
    category: "leitura",
    input: z.object({ report_id: z.uuid() }),
    summarize: () => "ler relatório",
    async execute(ctx, i) {
      const report = await findReport(ctx, i.report_id);
      return report;
    },
  }),
  tool({
    name: "criar_rascunho_relatorio",
    description:
      "Salva um relatório como rascunho para a equipe revisar. Nada vai para o cliente até alguém aprovar a publicação.",
    category: "rascunho",
    input: z.object({
      client_id: clientId,
      inicio: day,
      fim: day,
      titulo: z.string().min(1).max(160),
      conteudo_md: z.string().min(1).max(60_000).describe("Relatório em Markdown"),
    }),
    summarize: (i) => `salvar o rascunho "${i.titulo}"`,
    async execute(ctx, i) {
      const client = await assertClient(ctx, i.client_id);
      if (i.fim < i.inicio) throw new ToolError("A data final vem antes da inicial.");
      const row = await one<{ id: string }>(
        ctx.sql,
        `insert into reports (agency_id, client_id, period_start, period_end, title, body_md, created_by_xodo)
         values ($1, $2, $3::date, $4::date, $5, $6, $7) returning id`,
        [ctx.xodo.agency_id, client.id, i.inicio, i.fim, i.titulo, i.conteudo_md, ctx.xodo.id],
      );
      return { report_id: row!.id, status: "draft", cliente: client.name };
    },
  }),
  tool({
    name: "publicar_relatorio",
    description: "Publica um rascunho no portal do cliente. Sempre pede aprovação de alguém da equipe antes.",
    category: "cliente",
    input: z.object({ report_id: z.uuid() }),
    summarize: () => "publicar um relatório no portal do cliente",
    async execute(ctx, i) {
      await findReport(ctx, i.report_id);
      const row = await one<{ id: string }>(
        ctx.sql,
        `update reports set status = 'published', published_at = now(), updated_at = now()
          where id = $1 and agency_id = $2 and status = 'draft' returning id`,
        [i.report_id, ctx.xodo.agency_id],
      );
      if (!row) throw new ToolError("Só rascunhos podem ser publicados.");
      return { report_id: row.id, status: "published" };
    },
  }),
  tool({
    name: "avisar_equipe",
    description: "Manda um aviso para a equipe da agência (aparece nas notificações).",
    category: "equipe",
    input: z.object({ titulo: z.string().min(1).max(120), mensagem: z.string().max(2000).default("") }),
    summarize: (i) => `avisar a equipe: ${i.titulo}`,
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
  tool({
    name: "atualizar_memoria",
    description:
      "Reescreve sua memória (o texto que você recebe em toda conversa). Envie a memória inteira, já atualizada e resumida. Nunca guarde senhas ou chaves.",
    category: "memoria",
    input: z.object({ conteudo: z.string().max(24_000), motivo: z.string().min(1).max(200) }),
    summarize: (i) => `atualizar a memória (${i.motivo})`,
    async execute(ctx, i) {
      const saved = await saveMemory(ctx.sql, ctx.xodo.agency_id, ctx.xodo.id, i.conteudo, i.motivo);
      return { salvo: true, caracteres: saved.content.length, segredos_removidos: saved.redacted };
    },
  }),
];

async function findReport(ctx: ToolContext, id: string) {
  const report = await one<{ client_id: string } & Record<string, unknown>>(
    ctx.sql,
    `select id, client_id, title as titulo, status, period_start::text as inicio, period_end::text as fim, body_md as conteudo_md
       from reports where id = $1 and agency_id = $2`,
    [id, ctx.xodo.agency_id],
  );
  if (!report) throw new ToolError("Relatório não encontrado.");
  await assertClient(ctx, report.client_id);
  return report;
}

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
