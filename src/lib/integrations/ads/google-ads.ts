import { IntegrationError, requestJson } from "../http";
import type { AccountRef, AdPlatform, Campaign, PlatformAccess } from "./types";

/**
 * Google Ads pela API REST (consultas em GAQL). Precisa do developer token do Spherum e, para
 * contas dentro de uma MCC, do login-customer-id da MCC (guardado nos dados da conta).
 *
 * A versão da API muda a cada poucos meses e as antigas são desligadas: confira a atual e
 * ajuste GOOGLE_ADS_API_VERSION.
 */

const base = () => `https://googleads.googleapis.com/${process.env.GOOGLE_ADS_API_VERSION || "v23"}`;
const digits = (id: string) => id.replace(/\D/g, "");

function headers(account?: AccountRef): Record<string, string> {
  const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token) throw new IntegrationError("O Google Ads ainda não foi configurado no Spherum (GOOGLE_ADS_DEVELOPER_TOKEN).", 503);
  const login = account?.metadata?.login_customer_id;
  return { "developer-token": token, ...(login ? { "login-customer-id": digits(String(login)) } : {}) };
}

type Row = Record<string, Record<string, unknown>>;

async function search(a: PlatformAccess, customerId: string, query: string, account?: AccountRef): Promise<Row[]> {
  const out: Row[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r: { results?: Row[]; nextPageToken?: string } = await requestJson<{ results?: Row[]; nextPageToken?: string }>(
      a.http,
      `${base()}/customers/${digits(customerId)}/googleAds:search`,
      { method: "POST", bearer: a.accessToken, headers: headers(account), json: { query, ...(pageToken ? { pageToken } : {}) } },
    );
    out.push(...(r.results ?? []));
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

const micros = (v: unknown) => (Number(v) || 0) / 1_000_000;

function statusOf(raw: string): Campaign["status"] {
  if (raw === "ENABLED") return "ativa";
  if (raw === "PAUSED") return "pausada";
  return "outra";
}

/** Só datas no formato AAAA-MM-DD entram na consulta. */
function safeDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new IntegrationError("Data inválida.", 400);
  return day;
}

export const googleAds: AdPlatform = {
  id: "google",
  app: "google_ads",
  label: "Google Ads",
  async listAccounts(a) {
    const accessible = await requestJson<{ resourceNames?: string[] }>(a.http, `${base()}/customers:listAccessibleCustomers`, {
      bearer: a.accessToken,
      headers: headers(),
    });
    const accounts = new Map<string, { externalId: string; name: string; currency: string | null; metadata?: Record<string, unknown> }>();
    for (const resource of accessible.resourceNames ?? []) {
      const id = resource.split("/")[1];
      const [info] = await search(a, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1");
      const c = info?.customer ?? {};
      if (c.manager) {
        // Conta de administrador (MCC): lista as contas de baixo, que respondem com o login-customer-id dela.
        const children = await search(
          a,
          id,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager FROM customer_client WHERE customer_client.level = 1",
          { externalId: id, metadata: { login_customer_id: id } },
        );
        for (const child of children) {
          const cc = child.customerClient ?? {};
          if (cc.manager) continue;
          accounts.set(String(cc.id), {
            externalId: String(cc.id),
            name: String(cc.descriptiveName ?? cc.id),
            currency: (cc.currencyCode as string) ?? null,
            metadata: { login_customer_id: id },
          });
        }
      } else if (!accounts.has(id)) {
        accounts.set(id, { externalId: id, name: String(c.descriptiveName ?? id), currency: (c.currencyCode as string) ?? null });
      }
    }
    return [...accounts.values()];
  },
  async daily(a, account, since, until) {
    const rows = await search(
      a,
      account.externalId,
      `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks,
              metrics.conversions, metrics.conversions_value
         FROM campaign WHERE segments.date BETWEEN '${safeDay(since)}' AND '${safeDay(until)}'`,
      account,
    );
    return rows.map((r) => ({
      campaignId: String(r.campaign?.id),
      campaignName: (r.campaign?.name as string) ?? null,
      day: String(r.segments?.date),
      spend: micros(r.metrics?.costMicros),
      impressions: Number(r.metrics?.impressions) || 0,
      clicks: Number(r.metrics?.clicks) || 0,
      // O Google Ads não separa leads: tudo que a conta marca como conversão entra em conversões.
      leads: 0,
      conversions: Math.round(Number(r.metrics?.conversions) || 0),
      revenue: Number(r.metrics?.conversionsValue) || 0,
    }));
  },
  async campaigns(a, account) {
    const rows = await search(
      a,
      account.externalId,
      "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
      account,
    );
    return rows.map((r) => ({
      id: String(r.campaign?.id),
      name: String(r.campaign?.name ?? r.campaign?.id),
      status: statusOf(String(r.campaign?.status)),
      rawStatus: String(r.campaign?.status),
      dailyBudget: r.campaignBudget?.amountMicros !== undefined ? micros(r.campaignBudget.amountMicros) : null,
    }));
  },
  async setStatus(a, account, campaignId, active) {
    const cid = digits(account.externalId);
    await requestJson(a.http, `${base()}/customers/${cid}/campaigns:mutate`, {
      method: "POST",
      bearer: a.accessToken,
      headers: headers(account),
      json: {
        operations: [{ update: { resourceName: `customers/${cid}/campaigns/${digits(campaignId)}`, status: active ? "ENABLED" : "PAUSED" }, updateMask: "status" }],
      },
    });
  },
  async setDailyBudget(a, account, campaignId, amount) {
    const cid = digits(account.externalId);
    const [row] = await search(a, cid, `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${digits(campaignId)}`, account);
    const budget = row?.campaign?.campaignBudget as string | undefined;
    if (!budget) throw new IntegrationError("Não encontrei a verba desta campanha.", 404);
    await requestJson(a.http, `${base()}/customers/${cid}/campaignBudgets:mutate`, {
      method: "POST",
      bearer: a.accessToken,
      headers: headers(account),
      json: { operations: [{ update: { resourceName: budget, amountMicros: String(Math.round(amount * 1_000_000)) }, updateMask: "amount_micros" }] },
    });
  },
};
