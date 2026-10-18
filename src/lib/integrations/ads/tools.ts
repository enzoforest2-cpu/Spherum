import { z } from "zod";
import { num, parseJson } from "../../xodos/db";
import { usdBrl } from "../../xodos/fx";
import { appCall, assertClient, ToolError, type ToolContext, type ToolDef } from "../../xodos/tools";
import { AD_PLATFORMS, PLATFORM_APP, syncAccount, type AccountPlatform, type AccountRow } from "./sync";
import type { AdPlatformId, PlatformAccess } from "./types";

/**
 * Ferramentas de anúncio dos xodós. Cada uma recebe o cliente e a plataforma; a conta vem da
 * ligação cliente ↔ conta (client_ad_accounts), então o xodó só mexe em contas dos clientes
 * que atende. Mudanças de campanha são da categoria "campanha" (a autonomia decide) e a verba
 * respeita o limite do xodó: acima dele, sempre pede aprovação.
 */

const platform = z.enum(["meta", "google", "tiktok"]);
const LABEL: Record<AdPlatformId, string> = { meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads" };
const ADS_APPS = ["meta_ads", "google_ads", "tiktok_ads"] as const;

function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

type Resolved = { row: AccountRow; a: PlatformAccess };

/** Acha a conta do cliente na plataforma e o acesso a ela (o app precisa estar liberado ao xodó). */
async function account(ctx: ToolContext, clientId: string, p: AccountPlatform, accountId?: string): Promise<Resolved> {
  const client = await assertClient(ctx, clientId);
  const rows = await ctx.sql.query<AccountRow>(
    `select * from client_ad_accounts where agency_id = $1 and client_id = $2 and platform = $3 order by created_at`,
    [ctx.xodo.agency_id, client.id, p],
  );
  const chosen = accountId ? rows.find((r) => r.external_id === accountId) : rows.length === 1 ? rows[0] : null;
  if (!rows.length) throw new ToolError(`${client.name} não tem conta de ${p === "ga4" ? "GA4" : LABEL[p]} ligada no Spherum.`);
  if (!chosen) {
    throw new ToolError(`${client.name} tem mais de uma conta nessa plataforma. Informe a conta: ${rows.map((r) => `${r.external_id} (${r.name})`).join(", ")}.`);
  }
  if (!ctx.apps) throw new ToolError("As integrações não estão disponíveis agora.");
  if (!chosen.connection_id) throw new ToolError("A conta está sem conexão. Ligue a conta de novo em Integrações.");
  const access = await appCall(() => ctx.apps!.useConnection(PLATFORM_APP[p], chosen.connection_id!));
  return {
    row: { ...chosen, metadata: parseJson<Record<string, unknown>>(chosen.metadata) ?? {} },
    a: { accessToken: access.accessToken, http: access.http, connectionMetadata: access.connection.metadata },
  };
}

const ref = (row: AccountRow) => ({ externalId: row.external_id, metadata: row.metadata });

/** Fator para reais de uma conta (USD usa a cotação do dia; as demais ficam na moeda da conta). */
async function toBrlFactor(ctx: ToolContext, currency: string | null): Promise<number> {
  if (currency !== "USD") return 1;
  return (await usdBrl(ctx.sql, ctx.now.toISOString().slice(0, 10))) ?? 1;
}

const campaignInput = z.object({
  client_id: z.uuid(),
  plataforma: platform,
  campaign_id: z.string().trim().min(1).max(64),
  conta: z.string().trim().max(64).optional().describe("Id da conta, se o cliente tiver mais de uma na plataforma"),
});

export const ADS_TOOLS: ToolDef[] = [
  tool({
    name: "listar_contas_de_anuncio",
    description: "Lista as contas de anúncio e propriedades do GA4 ligadas a um cliente, com a última sincronização.",
    category: "leitura",
    app: [...ADS_APPS, "ga4"],
    input: z.object({ client_id: z.uuid() }),
    summarize: () => "listar contas de anúncio",
    async execute(ctx, i) {
      const client = await assertClient(ctx, i.client_id);
      const rows = await ctx.sql.query(
        `select platform as plataforma, external_id as conta, name as nome, currency as moeda,
                last_synced_at::text as sincronizado_em, last_sync_error as aviso
           from client_ad_accounts where agency_id = $1 and client_id = $2 order by platform, name`,
        [ctx.xodo.agency_id, client.id],
      );
      return { cliente: client.name, contas: rows };
    },
  }),
  tool({
    name: "listar_campanhas",
    description: "Campanhas de um cliente numa plataforma, ao vivo: situação (ativa/pausada) e verba diária em reais.",
    category: "leitura",
    app: [...ADS_APPS],
    input: z.object({ client_id: z.uuid(), plataforma: platform, conta: z.string().max(64).optional() }),
    summarize: (i) => `listar campanhas no ${LABEL[i.plataforma]}`,
    async execute(ctx, i) {
      const { row, a } = await account(ctx, i.client_id, i.plataforma, i.conta);
      const factor = await toBrlFactor(ctx, row.currency);
      const campaigns = await appCall(() => AD_PLATFORMS[i.plataforma].campaigns(a, ref(row)));
      return {
        conta: row.external_id,
        moeda: row.currency ?? "BRL",
        campanhas: campaigns.slice(0, 200).map((c) => ({
          id: c.id,
          nome: c.name,
          situacao: c.status,
          situacao_original: c.rawStatus,
          verba_diaria_brl: c.dailyBudget === null ? null : Math.round(c.dailyBudget * factor * 100) / 100,
        })),
      };
    },
  }),
  tool({
    name: "pausar_campanha",
    description: "Pausa uma campanha. Mexe em anúncio do cliente: segue a autonomia combinada.",
    category: "campanha",
    app: [...ADS_APPS],
    input: campaignInput,
    summarize: (i) => `pausar a campanha ${i.campaign_id} no ${LABEL[i.plataforma]}`,
    async execute(ctx, i) {
      const { row, a } = await account(ctx, i.client_id, i.plataforma, i.conta);
      await appCall(() => AD_PLATFORMS[i.plataforma].setStatus(a, ref(row), i.campaign_id, false));
      return { campanha: i.campaign_id, situacao: "pausada" };
    },
  }),
  tool({
    name: "ativar_campanha",
    description: "Ativa (retoma) uma campanha pausada. Mexe em anúncio do cliente: segue a autonomia combinada.",
    category: "campanha",
    app: [...ADS_APPS],
    input: campaignInput,
    summarize: (i) => `ativar a campanha ${i.campaign_id} no ${LABEL[i.plataforma]}`,
    async execute(ctx, i) {
      const { row, a } = await account(ctx, i.client_id, i.plataforma, i.conta);
      await appCall(() => AD_PLATFORMS[i.plataforma].setStatus(a, ref(row), i.campaign_id, true));
      return { campanha: i.campaign_id, situacao: "ativa" };
    },
  }),
  tool({
    name: "ajustar_verba_diaria",
    description:
      "Muda a verba diária de uma campanha (valor em reais). Mudanças acima do limite do xodó sempre pedem aprovação.",
    category: "campanha",
    app: [...ADS_APPS],
    input: campaignInput.extend({ nova_verba_brl: z.number().positive().max(10_000_000) }),
    summarize: (i) =>
      `mudar a verba diária da campanha ${i.campaign_id} no ${LABEL[i.plataforma]} para ${i.nova_verba_brl.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`,
    async mustAsk(ctx, i) {
      const max = ctx.xodo.campaign_max_daily_brl === null ? null : num(ctx.xodo.campaign_max_daily_brl);
      if (max !== null && i.nova_verba_brl > max) {
        return `acima do teto de ${max.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} por dia`;
      }
      const { row, a } = await account(ctx, i.client_id, i.plataforma, i.conta);
      const factor = await toBrlFactor(ctx, row.currency);
      const campaigns = await appCall(() => AD_PLATFORMS[i.plataforma].campaigns(a, ref(row)));
      const current = campaigns.find((c) => c.id === i.campaign_id);
      if (!current) throw new ToolError("Campanha não encontrada nesta conta.");
      if (current.dailyBudget === null) throw new ToolError("Esta campanha não tem verba diária no nível da campanha.");
      const before = current.dailyBudget * factor;
      const change = before > 0 ? (Math.abs(i.nova_verba_brl - before) / before) * 100 : Infinity;
      if (change > ctx.xodo.campaign_max_change_pct) {
        return `mudança de ${Number.isFinite(change) ? Math.round(change) : "∞"}%, acima do limite de ${ctx.xodo.campaign_max_change_pct}%`;
      }
      return null;
    },
    async execute(ctx, i) {
      const { row, a } = await account(ctx, i.client_id, i.plataforma, i.conta);
      const factor = await toBrlFactor(ctx, row.currency);
      await appCall(() => AD_PLATFORMS[i.plataforma].setDailyBudget(a, ref(row), i.campaign_id, i.nova_verba_brl / factor));
      return { campanha: i.campaign_id, verba_diaria_brl: i.nova_verba_brl };
    },
  }),
  tool({
    name: "atualizar_metricas",
    description: "Busca agora as métricas mais recentes das contas do cliente (as métricas também atualizam sozinhas a cada 6 horas).",
    category: "leitura",
    app: [...ADS_APPS, "ga4"],
    input: z.object({ client_id: z.uuid(), dias: z.number().int().min(1).max(90).default(3) }),
    summarize: () => "atualizar métricas",
    async execute(ctx, i) {
      const client = await assertClient(ctx, i.client_id);
      const rows = await ctx.sql.query<AccountRow>(
        `select * from client_ad_accounts where agency_id = $1 and client_id = $2 and connection_id is not null`,
        [ctx.xodo.agency_id, client.id],
      );
      if (!ctx.apps) throw new ToolError("As integrações não estão disponíveis agora.");
      const until = ctx.now.toISOString().slice(0, 10);
      const since = new Date(ctx.now.getTime() - (i.dias - 1) * 86_400_000).toISOString().slice(0, 10);
      const out = [];
      for (const row of rows) {
        try {
          // O app precisa estar liberado ao xodó; o acesso em si usa a conexão da conta.
          await ctx.apps.useConnection(PLATFORM_APP[row.platform], row.connection_id!);
          out.push({ plataforma: row.platform, conta: row.external_id, linhas: await syncAccount(ctx.apps.deps, row, since, until) });
        } catch (error) {
          out.push({ plataforma: row.platform, conta: row.external_id, erro: error instanceof Error ? error.message : String(error) });
        }
      }
      return { cliente: client.name, periodo: { inicio: since, fim: until }, contas: out };
    },
  }),
];

