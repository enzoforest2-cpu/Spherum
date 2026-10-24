import { one, parseJson, type Sql } from "../../xodos/db";
import { dayIn } from "../../xodos/budget";
import { usdBrl } from "../../xodos/fx";
import { APPS, missingScopes, type AppId } from "../apps";
import { IntegrationError } from "../http";
import { access, type IntegrationDeps } from "../store";
import { ga4Daily, listGa4Properties } from "./ga4";
import { googleAds } from "./google-ads";
import { metaAds } from "./meta";
import { tiktokAds } from "./tiktok";
import type { AdPlatform, AdPlatformId, PlatformAccess } from "./types";

/**
 * Contas de anúncio e propriedades do GA4 de cada cliente: descoberta, ligação e sincronização
 * diária das métricas (metrics_daily para mídia, analytics_daily para o GA4).
 */

export const AD_PLATFORMS: Record<AdPlatformId, AdPlatform> = { meta: metaAds, google: googleAds, tiktok: tiktokAds };
export type AccountPlatform = AdPlatformId | "ga4";
export const PLATFORM_APP: Record<AccountPlatform, AppId> = { meta: "meta_ads", google: "google_ads", tiktok: "tiktok_ads", ga4: "ga4" };

/** Dias que a sincronização puxa de novo: as plataformas corrigem números dos últimos dias. */
const RESYNC_DAYS = 3;
const BACKFILL_DAYS = 30;
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
/** Depois de uma falha, espera antes de tentar de novo (em vez de a cada ciclo do cron). */
const RETRY_AFTER_MS = 60 * 60 * 1000;
const RETRY_AFTER_REAUTH_MS = 24 * 60 * 60 * 1000;

export type AccountRow = {
  id: string;
  agency_id: string;
  client_id: string;
  platform: AccountPlatform;
  external_id: string;
  name: string | null;
  currency: string | null;
  connection_id: string | null;
  metadata: Record<string, unknown>;
  last_synced_at: Date | string | null;
};

/** Dia em Brasília: a janela de sincronização segue o calendário das agências, não o UTC. */
const isoDay = (d: Date) => dayIn("America/Sao_Paulo", d);

/** Conexão ativa mais recente da agência com as permissões do app. */
export async function connectionForApp(sql: Sql, agencyId: string, app: AppId): Promise<string> {
  const rows = await sql.query<{ id: string; scopes: string[] }>(
    `select id, scopes from integration_connections
      where agency_id = $1 and provider = any($2::text[]) and status = 'active' order by updated_at desc`,
    [agencyId, APPS[app].providers],
  );
  const ok = rows.find((r) => missingScopes(app, r.scopes).length === 0);
  if (!ok) throw new IntegrationError(`A agência ainda não conectou ${APPS[app].label} com as permissões necessárias.`, 409, true);
  return ok.id;
}

async function platformAccess(deps: IntegrationDeps, agencyId: string, connectionId: string): Promise<PlatformAccess> {
  const a = await access(deps, agencyId, connectionId);
  return { accessToken: a.accessToken, http: deps.fetch, connectionMetadata: a.connection.metadata };
}

/** Contas que a conexão enxerga, para a agência escolher qual é de qual cliente. */
export async function discoverAccounts(deps: IntegrationDeps, agencyId: string, platform: AccountPlatform, connectionId?: string) {
  const conn = connectionId ?? (await connectionForApp(deps.sql, agencyId, PLATFORM_APP[platform]));
  const a = await platformAccess(deps, agencyId, conn);
  const accounts =
    platform === "ga4"
      ? (await listGa4Properties(a)).map((p) => ({ externalId: p.externalId, name: `${p.name} (${p.account})`, currency: null, metadata: {} }))
      : await AD_PLATFORMS[platform].listAccounts(a);
  const linked = await deps.sql.query<{ external_id: string; client_id: string }>(
    `select external_id, client_id from client_ad_accounts where agency_id = $1 and platform = $2`,
    [agencyId, platform],
  );
  const byId = new Map(linked.map((l) => [l.external_id, l.client_id]));
  return accounts.map((acc) => ({ ...acc, connectionId: conn, clientId: byId.get(acc.externalId) ?? null }));
}

export type LinkInput = {
  agencyId: string;
  clientId: string;
  platform: AccountPlatform;
  externalId: string;
  name?: string | null;
  currency?: string | null;
  connectionId: string;
  metadata?: Record<string, unknown>;
};

/** Liga (ou muda de cliente) uma conta. O gatilho do banco recusa cliente de outra agência. */
export async function linkAccount(sql: Sql, input: LinkInput): Promise<string> {
  const conn = await one(sql, `select 1 from integration_connections where id = $1 and agency_id = $2 and status <> 'revoked'`, [
    input.connectionId,
    input.agencyId,
  ]);
  if (!conn) throw new IntegrationError("Conexão não encontrada nesta agência.", 404);
  const row = await one<{ id: string }>(
    sql,
    `insert into client_ad_accounts (agency_id, client_id, platform, external_id, name, currency, connection_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     on conflict (agency_id, platform, external_id) do update
       set client_id = excluded.client_id, name = excluded.name, currency = excluded.currency,
           connection_id = excluded.connection_id, metadata = excluded.metadata
     returning id`,
    [input.agencyId, input.clientId, input.platform, input.externalId, input.name ?? null, input.currency ?? null,
      input.connectionId, JSON.stringify(input.metadata ?? {})],
  );
  return row!.id;
}

export async function unlinkAccount(sql: Sql, agencyId: string, accountId: string) {
  await sql.query(`delete from client_ad_accounts where id = $1 and agency_id = $2`, [accountId, agencyId]);
}

/** Converte para reais: contas em BRL ficam como estão; em USD usam a cotação do dia. */
async function toBrl(sql: Sql, currency: string | null, day: string, value: number, cache: Map<string, number | null>, missing?: Set<string>) {
  if (!currency || currency === "BRL") return value;
  if (currency !== "USD") return value;
  if (!cache.has(day)) cache.set(day, await usdBrl(sql, day));
  const rate = cache.get(day);
  if (!rate) missing?.add(day);
  return rate ? value * rate : value;
}

const cents = (v: number) => Math.round(v * 100);

export async function syncAccount(deps: IntegrationDeps, row: AccountRow, since: string, until: string): Promise<number> {
  const { sql } = deps;
  if (!row.connection_id) throw new IntegrationError("Conta sem conexão. Ligue a conta de novo.", 409);
  const fxMissing = new Set<string>();
  try {
    const a = await platformAccess(deps, row.agency_id, row.connection_id);
    let count = 0;
    if (row.platform === "ga4") {
      for (const r of await ga4Daily(a, row.external_id, since, until)) {
        await sql.query(
          `insert into analytics_daily (agency_id, client_id, property_id, day, channel, sessions, users, key_events, revenue_cents)
           values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9)
           on conflict (client_id, property_id, day, channel) do update
             set sessions = excluded.sessions, users = excluded.users, key_events = excluded.key_events,
                 revenue_cents = excluded.revenue_cents`,
          [row.agency_id, row.client_id, row.external_id, r.day, r.channel, r.sessions, r.users, r.keyEvents, cents(r.revenue)],
        );
        count += 1;
      }
    } else {
      const fx = new Map<string, number | null>();
      const account = { externalId: row.external_id, metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {} };
      for (const r of await AD_PLATFORMS[row.platform].daily(a, account, since, until)) {
        await sql.query(
          `insert into metrics_daily (agency_id, client_id, platform, account_id, campaign_id, campaign_name, day,
             spend_cents, impressions, clicks, leads, conversions, revenue_cents)
           values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13)
           on conflict (client_id, platform, account_id, campaign_id, day) do update
             set campaign_name = excluded.campaign_name, spend_cents = excluded.spend_cents,
                 impressions = excluded.impressions, clicks = excluded.clicks, leads = excluded.leads,
                 conversions = excluded.conversions, revenue_cents = excluded.revenue_cents`,
          [row.agency_id, row.client_id, row.platform, row.external_id, r.campaignId, r.campaignName, r.day,
            cents(await toBrl(sql, row.currency, r.day, r.spend, fx, fxMissing)), r.impressions, r.clicks, r.leads, r.conversions,
            cents(await toBrl(sql, row.currency, r.day, r.revenue, fx, fxMissing))],
        );
        count += 1;
      }
    }
    const note = row.currency && !["BRL", "USD"].includes(row.currency)
      ? `Valores na moeda da conta (${row.currency}), sem conversão.`
      : row.currency === "USD" && fxMissing.size ? "Sem cotação do dólar para alguns dias: valores em USD guardados sem conversão." : null;
    const at = deps.now ? deps.now() : new Date();
    await sql.query(`update client_ad_accounts set last_synced_at = $2::timestamptz, next_sync_at = $3::timestamptz, last_sync_error = $4 where id = $1`, [
      row.id,
      at.toISOString(),
      new Date(at.getTime() + SYNC_EVERY_MS).toISOString(),
      note,
    ]);
    return count;
  } catch (error) {
    // Falhou: espera uma hora (um dia, se o login foi recusado) para não ocupar o cron a cada 15 minutos.
    const reauth = error instanceof IntegrationError && error.reauth;
    const at = deps.now ? deps.now() : new Date();
    await sql.query(`update client_ad_accounts set last_sync_error = $2, next_sync_at = $3::timestamptz where id = $1`, [
      row.id,
      String(error instanceof Error ? error.message : error).slice(0, 500),
      new Date(at.getTime() + (reauth ? RETRY_AFTER_REAUTH_MS : RETRY_AFTER_MS)).toISOString(),
    ]);
    // Login recusado pela plataforma: a conexão vence agora, e a tela pede para reconectar.
    if (reauth) {
      await sql.query(`update integration_connections set status = 'expired', last_error = $2, updated_at = now() where id = $1 and status = 'active'`, [
        row.connection_id,
        String(error instanceof Error ? error.message : error).slice(0, 300),
      ]);
    }
    throw error;
  }
}

/** Período a puxar: 30 dias na primeira vez; depois, os últimos 3 dias (inclusive hoje). */
export function syncWindow(row: Pick<AccountRow, "last_synced_at">, now: Date) {
  const days = row.last_synced_at ? RESYNC_DAYS : BACKFILL_DAYS;
  return { since: isoDay(new Date(now.getTime() - (days - 1) * 86_400_000)), until: isoDay(now) };
}

/** Chamado pelo cron: sincroniza as contas cuja próxima sincronização chegou (6 h depois da última; 1 h depois de uma falha). */
export async function syncDueAccounts(deps: IntegrationDeps, limit = 20) {
  const now = deps.now ? deps.now() : new Date();
  const due = await deps.sql.query<AccountRow>(
    `select * from client_ad_accounts
      where connection_id is not null and (next_sync_at is null or next_sync_at <= $1::timestamptz)
      order by next_sync_at nulls first, last_synced_at nulls first limit $2`,
    [now.toISOString(), limit],
  );
  const results: { account: string; rows?: number; error?: string }[] = [];
  for (const row of due) {
    const { since, until } = syncWindow(row, now);
    try {
      results.push({ account: row.external_id, rows: await syncAccount(deps, row, since, until) });
    } catch (error) {
      results.push({ account: row.external_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
