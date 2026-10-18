import type { AppId } from "../apps";
import type { Fetch } from "../http";

/** O que cada plataforma de anúncio entrega ao Spherum, numa forma só. */

export type AdPlatformId = "meta" | "google" | "tiktok";

export type AdAccount = {
  externalId: string;
  name: string;
  currency: string | null;
  metadata?: Record<string, unknown>;
};

/** Uma linha por campanha e dia. Valores em unidades da moeda da conta (ex.: 12.34 reais). */
export type DailyRow = {
  campaignId: string;
  campaignName: string | null;
  day: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  conversions: number;
  revenue: number;
};

export type Campaign = {
  id: string;
  name: string;
  /** Situação simplificada; o valor original vem em rawStatus. */
  status: "ativa" | "pausada" | "outra";
  rawStatus: string;
  /** Verba diária em unidades da moeda; nula quando a verba está em outro nível (conjuntos, vitalícia). */
  dailyBudget: number | null;
};

/** Token da conexão, fetch e os dados não secretos da conexão (ex.: anunciantes autorizados no login do TikTok). */
export type PlatformAccess = { accessToken: string; http: Fetch; connectionMetadata?: Record<string, unknown> };
export type AccountRef = { externalId: string; metadata: Record<string, unknown> };

export interface AdPlatform {
  id: AdPlatformId;
  app: AppId;
  label: string;
  listAccounts(a: PlatformAccess): Promise<AdAccount[]>;
  daily(a: PlatformAccess, account: AccountRef, since: string, until: string): Promise<DailyRow[]>;
  campaigns(a: PlatformAccess, account: AccountRef): Promise<Campaign[]>;
  setStatus(a: PlatformAccess, account: AccountRef, campaignId: string, active: boolean): Promise<void>;
  setDailyBudget(a: PlatformAccess, account: AccountRef, campaignId: string, amount: number): Promise<void>;
}
