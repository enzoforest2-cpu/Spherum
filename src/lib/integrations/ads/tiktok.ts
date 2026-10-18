import { tiktokJson } from "../oauth-providers";
import type { AdPlatform, Campaign, PlatformAccess } from "./types";

/** TikTok Ads pela Business API v1.3 (responde 200 com { code, data }; tiktokJson trata os erros). */

const auth = (a: PlatformAccess) => ({ "Access-Token": a.accessToken });
const q = (params: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();

function statusOf(raw: string): Campaign["status"] {
  if (raw === "ENABLE" || raw === "CAMPAIGN_STATUS_ENABLE") return "ativa";
  if (raw === "DISABLE" || raw === "CAMPAIGN_STATUS_DISABLE") return "pausada";
  return "outra";
}

export const tiktokAds: AdPlatform = {
  id: "tiktok",
  app: "tiktok_ads",
  label: "TikTok Ads",
  async listAccounts(a) {
    // Os anunciantes autorizados vêm no login; se faltarem, a API lista (pede app_id e secret do app do Spherum).
    let advertiserIds = ((a.connectionMetadata?.advertiser_ids as string[] | undefined) ?? []).map(String);
    if (!advertiserIds.length) {
      const ids = await tiktokJson<{ list?: { advertiser_id: string }[] }>(
        a.http,
        `/oauth2/advertiser/get/?${q({ app_id: process.env.TIKTOK_APP_ID ?? "", secret: process.env.TIKTOK_APP_SECRET ?? "" })}`,
        { headers: auth(a) },
      );
      advertiserIds = (ids.list ?? []).map((x) => x.advertiser_id);
    }
    if (!advertiserIds.length) return [];
    const info = await tiktokJson<{ list?: { advertiser_id: string; name?: string; currency?: string }[] }>(
      a.http,
      `/advertiser/info/?${q({ advertiser_ids: advertiserIds, fields: ["advertiser_id", "name", "currency"] })}`,
      { headers: auth(a) },
    );
    return (info.list ?? []).map((x) => ({ externalId: x.advertiser_id, name: x.name ?? x.advertiser_id, currency: x.currency ?? null }));
  },
  async daily(a, account, since, until) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const d = await tiktokJson<{
        list?: { dimensions: { campaign_id: string; stat_time_day: string }; metrics: Record<string, string> }[];
        page_info?: { total_page?: number };
      }>(
        a.http,
        `/report/integrated/get/?${q({
          advertiser_id: account.externalId,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: ["campaign_id", "stat_time_day"],
          metrics: ["campaign_name", "spend", "impressions", "clicks", "conversion"],
          start_date: since,
          end_date: until,
          page,
          page_size: 1000,
        })}`,
        { headers: auth(a) },
      );
      for (const r of d.list ?? []) {
        out.push({
          campaignId: r.dimensions.campaign_id,
          campaignName: r.metrics.campaign_name ?? null,
          day: r.dimensions.stat_time_day.slice(0, 10),
          spend: Number(r.metrics.spend) || 0,
          impressions: Number(r.metrics.impressions) || 0,
          clicks: Number(r.metrics.clicks) || 0,
          leads: 0,
          conversions: Math.round(Number(r.metrics.conversion) || 0),
          revenue: 0,
        });
      }
      if (page >= (d.page_info?.total_page ?? 1)) break;
    }
    return out;
  },
  async campaigns(a, account) {
    const d = await tiktokJson<{ list?: { campaign_id: string; campaign_name: string; operation_status: string; budget?: number; budget_mode?: string }[] }>(
      a.http,
      `/campaign/get/?${q({ advertiser_id: account.externalId, fields: ["campaign_id", "campaign_name", "operation_status", "budget", "budget_mode"], page_size: 1000 })}`,
      { headers: auth(a) },
    );
    return (d.list ?? []).map((c) => ({
      id: c.campaign_id,
      name: c.campaign_name,
      status: statusOf(c.operation_status),
      rawStatus: c.operation_status,
      dailyBudget: c.budget_mode === "BUDGET_MODE_DAY" && c.budget !== undefined ? Number(c.budget) : null,
    }));
  },
  async setStatus(a, account, campaignId, active) {
    await tiktokJson(a.http, "/campaign/status/update/", {
      method: "POST",
      headers: auth(a),
      json: { advertiser_id: account.externalId, campaign_ids: [campaignId], operation_status: active ? "ENABLE" : "DISABLE" },
    });
  },
  async setDailyBudget(a, account, campaignId, amount) {
    await tiktokJson(a.http, "/campaign/update/", {
      method: "POST",
      headers: auth(a),
      json: { advertiser_id: account.externalId, campaign_id: campaignId, budget: Math.round(amount * 100) / 100 },
    });
  },
};
