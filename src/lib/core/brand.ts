import { z } from "zod";
import { requestJson, IntegrationError, type Fetch } from "../integrations/http";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import { rankOf, type PlanId } from "./subscription";

/**
 * Marca da agência (nome, logo, cor, onde aparece) e domínio próprio do portal do cliente.
 *
 * - Portal do cliente com a marca: a partir do plano Agência.
 * - Portal da agência com a marca e sem "Desenvolvido com Spherum": a partir do Escala.
 * - Domínio próprio (ex.: portal.suaagencia.com.br): a partir do Escala, ou no Agência com o add-on. O Spherum cadastra o
 *   domínio no projeto da Vercel (VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID) e a agência cria
 *   o registro de DNS que a Vercel pede; quem abre o domínio cai no portal do cliente.
 * No teste grátis valem os limites do plano Agência.
 */

export type Brand = { name: string | null; on_client: boolean; on_agency: boolean; side: "dark" | "brand"; powered: boolean };
const DEFAULT: Brand = { name: null, on_client: true, on_agency: false, side: "dark", powered: true };

async function planRank(sql: Sql, agencyId: string) {
  const a = await one<{ plan: PlanId; plan_status: string }>(sql, `select plan, plan_status from agencies where id = $1`, [agencyId]);
  if (!a) throw new XodoError("Agência não encontrada.", 404);
  return rankOf(a.plan_status === "trial" ? "agencia" : a.plan);
}

export const brandInput = z.object({
  name: z.string().trim().max(60).nullable().optional(),
  on_client: z.boolean().optional(),
  on_agency: z.boolean().optional(),
  side: z.enum(["dark", "brand"]).optional(),
  powered: z.boolean().optional(),
});

/** A marca como vale para o plano de agora (o que o plano não permite fica desligado). */
export async function brandOf(sql: Sql, agencyId: string) {
  const a = await one<{ name: string; brand: Partial<Brand>; brand_color: string | null; logo_updated_at: string | null; plan: PlanId; plan_status: string }>(sql,
    `select name, brand, brand_color, logo_updated_at::text, plan, plan_status from agencies where id = $1`, [agencyId]);
  if (!a) throw new XodoError("Agência não encontrada.", 404);
  const rank = rankOf(a.plan_status === "trial" ? "agencia" : a.plan);
  const b = { ...DEFAULT, ...(a.brand ?? {}) };
  return {
    name: b.name || a.name,
    color: a.brand_color,
    logo_url: a.logo_updated_at ? `/api/public/logo/${agencyId}?v=${Date.parse(a.logo_updated_at)}` : null,
    on_client: rank >= 1 && b.on_client,
    on_agency: rank >= 2 && b.on_agency,
    side: b.side,
    powered: rank < 2 || b.powered,
  };
}

export async function setBrand(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const i = brandInput.parse(raw);
  const rank = await planRank(sql, agencyId);
  if (i.on_client && rank < 1) throw new XodoError("O portal do cliente com a sua marca começa no plano Agência.", 402);
  if (i.on_agency && rank < 2) throw new XodoError("O portal da agência com a sua marca começa no plano Escala.", 402);
  if (i.powered === false && rank < 2) throw new XodoError("Tirar “Desenvolvido com Spherum” começa no plano Escala.", 402);
  const patch = Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined));
  await sql.query(`update agencies set brand = brand || $2::jsonb where id = $1`, [agencyId, json(patch)]);
  await audit(sql, { agencyId, actor: userId, action: "marca_alterada", targetType: "agency", targetId: agencyId, summary: Object.keys(patch).join(", ") });
  return brandOf(sql, agencyId);
}

const logoInput = z.object({
  logo: z.string().max(1_500_000, "A logo precisa ter até 1 MB.").regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, "Envie a logo em PNG, JPG, WEBP ou SVG.").nullable(),
});

/** Troca (ou tira) a logo. O SVG pode carregar script: só entra servido com tipo de imagem e sem rodar na página. */
export async function setLogo(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const { logo } = logoInput.parse(raw);
  await sql.query(`update agencies set logo_data = $2, logo_updated_at = case when $2::text is null then null else now() end where id = $1`, [agencyId, logo]);
  await audit(sql, { agencyId, actor: userId, action: logo ? "logo_alterada" : "logo_removida", targetType: "agency", targetId: agencyId });
  return brandOf(sql, agencyId);
}

export async function logoOf(sql: Sql, agencyId: string) {
  const row = await one<{ logo_data: string | null }>(sql, `select logo_data from agencies where id = $1 and suspended_at is null`, [agencyId]);
  const m = row?.logo_data?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  return m ? { type: m[1], body: Buffer.from(m[2], "base64") } : null;
}

// ---------------------------------------------------------------------------
// Domínio próprio
// ---------------------------------------------------------------------------

export type VercelEnv = { token?: string; projectId?: string; teamId?: string };
export const vercelEnv = (env: Record<string, string | undefined> = process.env): VercelEnv => ({
  token: env.VERCEL_TOKEN, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID,
});

/** Domínios do próprio Spherum: nunca viram domínio de agência. */
const OWN = /(^|\.)(spherum\.com\.br|vercel\.app|vercel\.com|localhost)$/;
/** Subdomínios do Spherum que não podem ser de agência. */
const RESERVED = new Set(["www", "app", "api", "admin", "status", "mail", "email", "suporte", "ajuda", "blog", "docs", "cliente", "clientes", "agencia", "portal", "static", "cdn"]);

/** { domain } para domínio próprio (Escala) ou { sub } para nome.spherum.com.br (Agência). */
export const domainInput = z.union([
  z.object({
    domain: z.string().trim().toLowerCase().max(253)
      .transform((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .pipe(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Use um endereço como portal.suaagencia.com.br."))
      .refine((d) => !OWN.test(d), "Use um domínio da sua agência."),
  }),
  z.object({
    sub: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/, "Use de 3 a 40 letras, números ou hífen.").refine((s) => !RESERVED.has(s), "Esse nome é reservado. Escolha outro."),
  }),
]);

type VercelDomain = { name: string; verified: boolean; verification?: { type: string; domain: string; value: string; reason?: string }[] };

async function vercel<T>(http: Fetch, env: VercelEnv, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.token || !env.projectId) throw new XodoError("O domínio próprio ainda não foi ligado no Spherum (falta a configuração da Vercel). Fale com o suporte.", 503);
  const url = `https://api.vercel.com${path.replace(":project", encodeURIComponent(env.projectId))}${env.teamId ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(env.teamId)}` : ""}`;
  return requestJson<T>(http, url, { method, bearer: env.token, ...(body !== undefined ? { json: body } : {}) });
}

/** Registros de DNS que a agência precisa criar: o da Vercel quando pede verificação, mais o apontamento. */
function recordsFor(d: VercelDomain) {
  // Subdomínio do Spherum: o DNS é do Spherum (um registro *.spherum.com.br para a Vercel), nada a fazer.
  if (d.name.endsWith(".spherum.com.br")) return [];
  const apex = d.name.split(".").length <= 2 || /\.(com|net|org|art|adv|eng|med|ind)\.br$/.test(d.name) && d.name.split(".").length <= 3;
  const point = apex ? { type: "A", name: "@", value: "76.76.21.21" } : { type: "CNAME", name: d.name.split(".")[0], value: "cname.vercel-dns.com" };
  return [point, ...(d.verification ?? []).map((v) => ({ type: v.type, name: v.domain, value: v.value }))];
}

export async function domainOf(sql: Sql, agencyId: string) {
  return one<{ domain: string; status: string; records: unknown; error: string | null; checked_at: string | null; verified_at: string | null }>(sql,
    `select domain, status, records, error, checked_at::text, verified_at::text from agency_domains where agency_id = $1`, [agencyId]);
}

export async function setDomain(sql: Sql, http: Fetch, env: VercelEnv, agencyId: string, userId: string, raw: unknown) {
  const input = domainInput.parse(raw);
  const own = "domain" in input, domain = own ? input.domain : `${input.sub}.spherum.com.br`;
  const rank = await planRank(sql, agencyId);
  // Domínio próprio: incluso no Escala; no Agência, com o add-on "Portal no seu próprio domínio".
  const addon = own && rank === 1 ? await one(sql, `select 1 from agency_addons where agency_id = $1 and addon_id = 'domain' and qty > 0`, [agencyId]) : null;
  if (own && rank < 2 && !addon) throw new XodoError(rank === 1 ? "O domínio próprio vem no plano Escala ou com o add-on “Portal no seu próprio domínio” (Configurações → Plano e cobrança)." : "O domínio próprio começa no plano Escala.", 402);
  if (!own && rank < 1) throw new XodoError("O subdomínio com o nome da agência começa no plano Agência.", 402);
  const taken = await one(sql, `select 1 from agency_domains where domain = $1 and agency_id <> $2`, [domain, agencyId]);
  if (taken) throw new XodoError("Esse domínio já está em uso em outra agência.", 409);
  const old = await domainOf(sql, agencyId);
  if (old && old.domain !== domain) await removeDomain(sql, http, env, agencyId, userId);
  let d: VercelDomain;
  try {
    d = await vercel<VercelDomain>(http, env, "POST", "/v10/projects/:project/domains", { name: domain });
  } catch (error) {
    // Já cadastrado neste projeto: lê de volta.
    if (error instanceof IntegrationError && error.status === 409) d = await vercel<VercelDomain>(http, env, "GET", `/v9/projects/:project/domains/${encodeURIComponent(domain)}`);
    else if (error instanceof IntegrationError) throw new XodoError(`A Vercel não aceitou o domínio: ${error.message}`, 400);
    else throw error;
  }
  await sql.query(
    `insert into agency_domains (agency_id, domain, status, records, error, checked_at) values ($1, $2, 'pendente', $3::jsonb, null, now())
     on conflict (agency_id) do update set domain = excluded.domain, status = 'pendente', records = excluded.records, error = null, checked_at = now(), verified_at = null`,
    [agencyId, domain, json(recordsFor(d))],
  );
  await audit(sql, { agencyId, actor: userId, action: "dominio_cadastrado", targetType: "agency", targetId: agencyId, summary: domain });
  return checkDomain(sql, http, env, agencyId);
}

/** Confere na Vercel se o domínio está verificado e apontando certo. */
export async function checkDomain(sql: Sql, http: Fetch, env: VercelEnv, agencyId: string) {
  const cur = await domainOf(sql, agencyId);
  if (!cur) throw new XodoError("Nenhum domínio cadastrado.", 404);
  try {
    let d = await vercel<VercelDomain>(http, env, "GET", `/v9/projects/:project/domains/${encodeURIComponent(cur.domain)}`);
    if (!d.verified) d = await vercel<VercelDomain>(http, env, "POST", `/v9/projects/:project/domains/${encodeURIComponent(cur.domain)}/verify`).catch(() => d);
    const cfg = await vercel<{ misconfigured?: boolean }>(http, env, "GET", `/v6/domains/${encodeURIComponent(cur.domain)}/config`);
    const ok = d.verified && !cfg.misconfigured;
    await sql.query(
      `update agency_domains set status = $2, records = $3::jsonb, error = null, checked_at = now(), verified_at = case when $2 = 'ativo' then coalesce(verified_at, now()) else null end where agency_id = $1`,
      [agencyId, ok ? "ativo" : "pendente", json(recordsFor(d))],
    );
  } catch (error) {
    if (error instanceof XodoError) throw error;
    await sql.query(`update agency_domains set status = 'erro', error = $2, checked_at = now() where agency_id = $1`, [agencyId, String((error as Error).message).slice(0, 400)]);
  }
  return domainOf(sql, agencyId);
}

export async function removeDomain(sql: Sql, http: Fetch, env: VercelEnv, agencyId: string, userId: string) {
  const cur = await domainOf(sql, agencyId);
  if (!cur) return { ok: true };
  // Tirar da Vercel é melhor esforço: o domínio já não leva a nada sem a linha no banco.
  await vercel(http, env, "DELETE", `/v9/projects/:project/domains/${encodeURIComponent(cur.domain)}`).catch((error) => console.warn("[dominio] não saiu da Vercel", cur.domain, error instanceof Error ? error.message : error));
  await sql.query(`delete from agency_domains where agency_id = $1`, [agencyId]);
  await audit(sql, { agencyId, actor: userId, action: "dominio_removido", targetType: "agency", targetId: agencyId, summary: cur.domain });
  return { ok: true };
}

/** Marca pública para a tela de entrada no domínio da agência (sem dados privados). */
export async function brandForHost(sql: Sql, host: string) {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (!h || RESERVED.has(h.split(".")[0]) && h.endsWith(".spherum.com.br")) return null;
  const row = await one<{ agency_id: string }>(sql,
    `select d.agency_id from agency_domains d join agencies a on a.id = d.agency_id where d.domain = $1 and d.status = 'ativo' and a.suspended_at is null`, [h]);
  if (!row) return null;
  const b = await brandOf(sql, row.agency_id);
  return { agency_id: row.agency_id, name: b.name, color: b.color, logo_url: b.logo_url, powered: b.powered };
}
