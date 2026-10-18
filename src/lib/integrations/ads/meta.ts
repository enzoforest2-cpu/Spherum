import { IntegrationError, requestJson } from "../http";
import { metaGraph } from "../oauth-providers";
import type { AdPlatform, Campaign, DailyRow } from "./types";

/**
 * Meta Ads pela Graph API (API de Marketing). Insights por campanha e dia; leads e compras
 * saem de "actions"; receita, de "action_values".
 */

const LEAD_ACTIONS = new Set(["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"]);
const PURCHASE_ACTIONS = new Set(["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"]);

type ActionStat = { action_type: string; value: string };
type Paged<T> = { data: T[]; paging?: { next?: string } };

/** Soma ações de um tipo. A Meta repete a mesma compra em vários action_type; pega o maior para não contar em dobro. */
function pick(actions: ActionStat[] | undefined, types: Set<string>): number {
  const values = (actions ?? []).filter((a) => types.has(a.action_type)).map((a) => Number(a.value) || 0);
  return values.length ? Math.max(...values) : 0;
}

async function all<T>(a: { accessToken: string; http: typeof fetch }, first: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = first;
  for (let page = 0; next && page < 50; page++) {
    const r: Paged<T> = await requestJson<Paged<T>>(a.http, next, { bearer: a.accessToken });
    out.push(...r.data);
    next = r.paging?.next;
  }
  return out;
}

const act = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

function statusOf(raw: string): Campaign["status"] {
  if (raw === "ACTIVE") return "ativa";
  if (raw === "PAUSED") return "pausada";
  return "outra";
}

export const metaAds: AdPlatform = {
  id: "meta",
  app: "meta_ads",
  label: "Meta Ads",
  async listAccounts(a) {
    const rows = await all<{ id: string; name: string; currency?: string; account_status?: number }>(
      a,
      `${metaGraph()}/me/adaccounts?fields=id,name,currency,account_status&limit=200`,
    );
    return rows.map((r) => ({ externalId: act(r.id), name: r.name, currency: r.currency ?? null, metadata: { account_status: r.account_status } }));
  },
  async daily(a, account, since, until) {
    const params = new URLSearchParams({
      level: "campaign",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
      limit: "500",
    });
    const rows = await all<{
      campaign_id: string;
      campaign_name?: string;
      date_start: string;
      spend?: string;
      impressions?: string;
      clicks?: string;
      actions?: ActionStat[];
      action_values?: ActionStat[];
    }>(a, `${metaGraph()}/${act(account.externalId)}/insights?${params}`);
    return rows.map(
      (r): DailyRow => ({
        campaignId: r.campaign_id,
        campaignName: r.campaign_name ?? null,
        day: r.date_start,
        spend: Number(r.spend) || 0,
        impressions: Number(r.impressions) || 0,
        clicks: Number(r.clicks) || 0,
        leads: pick(r.actions, LEAD_ACTIONS),
        conversions: pick(r.actions, PURCHASE_ACTIONS),
        revenue: pick(r.action_values, PURCHASE_ACTIONS),
      }),
    );
  },
  async campaigns(a, account) {
    const rows = await all<{ id: string; name: string; status: string; effective_status?: string; daily_budget?: string }>(
      a,
      `${metaGraph()}/${act(account.externalId)}/campaigns?fields=id,name,status,effective_status,daily_budget&limit=200`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: statusOf(r.status),
      rawStatus: r.effective_status ?? r.status,
      // A Meta guarda a verba em centavos da moeda da conta.
      dailyBudget: r.daily_budget ? Number(r.daily_budget) / 100 : null,
    }));
  },
  async setStatus(a, _account, campaignId, active) {
    await requestJson(a.http, `${metaGraph()}/${campaignId}`, { method: "POST", bearer: a.accessToken, form: { status: active ? "ACTIVE" : "PAUSED" } });
  },
  async setDailyBudget(a, _account, campaignId, amount) {
    const current = await requestJson<{ daily_budget?: string }>(a.http, `${metaGraph()}/${campaignId}?fields=daily_budget`, { bearer: a.accessToken });
    if (!current.daily_budget) {
      throw new IntegrationError("Esta campanha não tem verba diária no nível da campanha (a verba está nos conjuntos de anúncios).", 400);
    }
    await requestJson(a.http, `${metaGraph()}/${campaignId}`, {
      method: "POST",
      bearer: a.accessToken,
      form: { daily_budget: String(Math.round(amount * 100)) },
    });
  },
};
