import { z } from "zod";
import { whatsappQrGroupMembers, whatsappQrGroups } from "../channels/whatsapp-qr";
import { IntegrationError, requestJson } from "../integrations/http";
import { metaGraph } from "../integrations/oauth-providers";
import { access, saveConnection, type IntegrationDeps } from "../integrations/store";
import type { Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { normPhone } from "./prospect";

/**
 * Fontes da Prospecção (no jeito do ReDrive: busca, confere, escolhe e importa para uma lista):
 *  - Google Maps: Places API (Text Search) com a chave do Google Cloud da agência;
 *  - Empresas por CNAE: pesquisa da CNPJá (Receita Federal) com a chave da agência;
 *  - Instagram: perfis comerciais pelo @, com a conta da Meta conectada (Business Discovery);
 *  - Grupos de WhatsApp: participantes dos grupos do número ligado por QR Code.
 * Nada é importado aqui: a busca devolve candidatos, e a tela manda os escolhidos para importLeads,
 * que confere telefone, repetidos e a lista de bloqueio. A origem de cada contato fica gravada.
 */

export type Candidate = {
  key: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  mobile: boolean;
  email: string | null;
  segment: string | null;
  city: string | null;
  website: string | null;
  origin: string;
  info: string | null;
  /** Já está numa lista da agência, ou pediu para não receber mais. */
  exists: boolean;
  blocked: boolean;
};

export const SOURCE_KEYS = { maps: "google_places", cnpj: "cnpja" } as const;
type KeySource = keyof typeof SOURCE_KEYS;

const isMobile = (p: string | null) => !!p && /^55\d{2}9\d{8}$/.test(p);
const cut = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Marca quem já está nas listas ou bloqueado (opt-out). */
async function mark(sql: Sql, agencyId: string, items: Omit<Candidate, "exists" | "blocked">[]): Promise<Candidate[]> {
  const phones = [...new Set(items.map((i) => i.phone).filter((p): p is string => !!p))];
  const [ex, bl] = phones.length
    ? await Promise.all([
        sql.query<{ phone: string }>(`select phone from prospect_leads where agency_id = $1 and phone = any($2::text[])`, [agencyId, phones]),
        sql.query<{ phone: string }>(`select phone from prospect_optouts where agency_id = $1 and phone = any($2::text[])`, [agencyId, phones]),
      ])
    : [[], []];
  const e = new Set(ex.map((r) => r.phone)), b = new Set(bl.map((r) => r.phone));
  return items.map((i) => ({ ...i, exists: !!i.phone && e.has(i.phone), blocked: !!i.phone && b.has(i.phone) }));
}

async function keyConnection(sql: Sql, agencyId: string, provider: string) {
  const rows = await sql.query<{ id: string }>(
    `select id from integration_connections where agency_id = $1 and provider = $2 and status = 'active' order by created_at desc limit 1`,
    [agencyId, provider],
  );
  return rows[0]?.id ?? null;
}

async function keyOf(deps: IntegrationDeps, agencyId: string, source: KeySource): Promise<string> {
  const id = await keyConnection(deps.sql, agencyId, SOURCE_KEYS[source]);
  if (!id) throw new XodoError(source === "maps" ? "Cadastre a chave do Google Maps primeiro." : "Cadastre a chave da CNPJá primeiro.", 409);
  const key = (await access(deps, agencyId, id)).secret.apiKey;
  if (!key) throw new XodoError("A chave guardada está incompleta. Cadastre de novo.", 409);
  return key;
}

// ---------------------------------------------------------------------------
// Chaves (Google Maps e CNPJá)
// ---------------------------------------------------------------------------

export const keyInput = z.object({ source: z.enum(["maps", "cnpj"]), key: z.string().trim().regex(/^[A-Za-z0-9_:.\-]{16,300}$/, "Chave inválida: cole sem espaços.") });

/** Confere a chave com uma chamada barata e guarda cifrada. */
export async function connectSourceKey(deps: IntegrationDeps, agencyId: string, userId: string, raw: unknown) {
  const { source, key } = keyInput.parse(raw);
  if (source === "maps") await placesSearch(deps, key, "padaria em São Paulo", undefined, 1);
  else await cnpjaSearch(deps, key, { "mainActivity.id.in": "4721102", "address.state.in": "SP", limit: "1" });
  const id = await saveConnection(deps, {
    agencyId,
    provider: SOURCE_KEYS[source],
    label: source === "maps" ? "Google Maps" : "CNPJá",
    account: `${SOURCE_KEYS[source]}:${key.slice(-6)}`,
    secret: { apiKey: key },
    createdBy: userId,
  });
  // Uma chave por fonte: a nova substitui as anteriores.
  await deps.sql.query(`update integration_connections set status = 'revoked' where agency_id = $1 and provider = $2 and id <> $3 and status <> 'revoked'`, [agencyId, SOURCE_KEYS[source], id]);
  return { id };
}

// ---------------------------------------------------------------------------
// Google Maps (Places API, Text Search)
// ---------------------------------------------------------------------------

type Place = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  primaryTypeDisplayName?: { text?: string };
  addressComponents?: { longText?: string; types?: string[] }[];
  businessStatus?: string;
};

const PLACE_FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.nationalPhoneNumber", "places.internationalPhoneNumber",
  "places.websiteUri", "places.rating", "places.userRatingCount", "places.primaryTypeDisplayName", "places.addressComponents", "places.businessStatus", "nextPageToken",
].join(",");

async function placesSearch(deps: IntegrationDeps, key: string, textQuery: string, pageToken: string | undefined, pageSize = 20) {
  try {
    return await requestJson<{ places?: Place[]; nextPageToken?: string }>(deps.fetch, "https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": PLACE_FIELDS },
      json: { textQuery, languageCode: "pt-BR", regionCode: "BR", pageSize, ...(pageToken ? { pageToken } : {}) },
    });
  } catch (error) {
    if (error instanceof IntegrationError && [400, 401, 403].includes(error.status))
      throw new XodoError(`O Google recusou a chave: ${error.message} Confira se a "Places API (New)" está ativada no projeto do Google Cloud.`, 400);
    throw error;
  }
}

export const mapsInput = z.object({
  query: z.string().trim().min(2, "Diga o que procurar (ex.: clínica odontológica).").max(120),
  city: z.string().trim().min(2, "Diga a cidade.").max(80),
  page_token: z.string().max(2000).optional(),
});

export async function searchMaps(deps: IntegrationDeps, agencyId: string, raw: unknown) {
  const input = mapsInput.parse(raw);
  const key = await keyOf(deps, agencyId, "maps");
  const r = await placesSearch(deps, key, `${input.query} em ${input.city}`, input.page_token);
  const items = (r.places ?? [])
    .filter((p) => p.businessStatus !== "CLOSED_PERMANENTLY")
    .map((p) => {
      const phone = normPhone(p.internationalPhoneNumber || p.nationalPhoneNumber || "");
      const city = p.addressComponents?.find((c) => c.types?.includes("administrative_area_level_2"))?.longText ?? input.city;
      const name = cut(p.displayName?.text, 160);
      return {
        key: `maps:${p.id ?? name}`,
        name: null,
        company: name,
        phone,
        mobile: isMobile(phone),
        email: null,
        segment: cut(p.primaryTypeDisplayName?.text, 80) ?? cut(input.query, 80),
        city: cut(city, 80),
        website: cut(p.websiteUri, 300),
        origin: `Google Maps: "${input.query}" em ${input.city}`,
        info: [p.formattedAddress, p.rating ? `★ ${p.rating.toFixed(1)} (${p.userRatingCount ?? 0})` : null].filter(Boolean).join(" · ") || null,
      };
    });
  return { items: await mark(deps.sql, agencyId, items), next: r.nextPageToken ?? null };
}

// ---------------------------------------------------------------------------
// Empresas por CNAE (CNPJá, base da Receita Federal)
// ---------------------------------------------------------------------------

type Office = {
  taxId: string;
  alias?: string | null;
  company?: { name?: string };
  address?: { city?: string; state?: string; district?: string; municipality?: number };
  phones?: { type?: string; area?: string; number?: string }[];
  emails?: { address?: string; ownership?: string }[];
  mainActivity?: { id?: number; text?: string };
  founded?: string;
};

async function cnpjaSearch(deps: IntegrationDeps, key: string, query: Record<string, string>) {
  try {
    return await requestJson<{ records?: Office[]; next?: string | null; count?: number }>(deps.fetch, `https://api.cnpja.com/office?${new URLSearchParams(query)}`, {
      headers: { Authorization: key },
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (error instanceof IntegrationError && [401, 403].includes(error.status)) throw new XodoError("A CNPJá recusou a chave. Confira no painel da CNPJá.", 400);
    if (error instanceof IntegrationError && error.status === 429) throw new XodoError("Os créditos ou o limite da CNPJá acabaram por agora. Veja o saldo no painel da CNPJá.", 429);
    throw error;
  }
}

const UFS = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SP", "SE", "TO"] as const;

export const cnpjInput = z.object({
  cnae: z.array(z.string().regex(/^\d{7}$/, "CNAE com 7 dígitos.")).min(1, "Escolha ao menos uma atividade (CNAE).").max(10),
  uf: z.enum(UFS),
  city: z.string().trim().max(80).optional(),
  mobile_only: z.boolean().default(true),
  with_email: z.boolean().default(false),
  limit: z.number().int().min(10).max(100).default(50),
  token: z.string().max(2000).optional(),
});

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
let ibgeCache: Map<string, { id: number; nome: string }[]> | null = null;

/** Código IBGE da cidade (a CNPJá filtra município pelo código). */
async function municipality(deps: IntegrationDeps, uf: string, city: string): Promise<number> {
  ibgeCache ??= new Map();
  let list = ibgeCache.get(uf);
  if (!list) {
    list = await requestJson<{ id: number; nome: string }[]>(deps.fetch, `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`);
    ibgeCache.set(uf, list);
  }
  const hit = list.find((m) => strip(m.nome) === strip(city));
  if (!hit) throw new XodoError(`Não achei a cidade "${city}" em ${uf}. Confira a grafia.`, 400);
  return hit.id;
}

let cnaeCache: { id: string; text: string }[] | null = null;

/** Atividades (CNAE subclasses do IBGE) pelo texto ou pelo código, para a tela escolher. */
export async function searchCnae(deps: IntegrationDeps, text: string) {
  const q = strip(text);
  if (q.length < 2) return [];
  if (!cnaeCache) {
    const raw = await requestJson<{ id: string; descricao: string }[]>(deps.fetch, "https://servicodados.ibge.gov.br/api/v2/cnae/subclasses", { timeoutMs: 30_000 });
    cnaeCache = raw.map((c) => ({ id: c.id.replace(/\D/g, ""), text: c.descricao.charAt(0) + c.descricao.slice(1).toLowerCase() }));
  }
  const digits = q.replace(/\D/g, "");
  const words = q.split(/\s+/);
  return cnaeCache
    .filter((c) => (digits.length >= 4 ? c.id.startsWith(digits) : words.every((w) => strip(c.text).includes(w))))
    .slice(0, 20);
}

export async function searchCnpj(deps: IntegrationDeps, agencyId: string, raw: unknown) {
  const input = cnpjInput.parse(raw);
  const key = await keyOf(deps, agencyId, "cnpj");
  const query: Record<string, string> = input.token
    ? { token: input.token }
    : {
        "mainActivity.id.in": input.cnae.join(","),
        "address.state.in": input.uf,
        "status.id.in": "2",
        "phones.ex": "true",
        limit: String(input.limit),
        ...(input.city ? { "address.municipality.in": String(await municipality(deps, input.uf, input.city)) } : {}),
        ...(input.mobile_only ? { "phones.type.in": "MOBILE" } : {}),
        ...(input.with_email ? { "emails.ex": "true" } : {}),
      };
  const r = await cnpjaSearch(deps, key, query);
  const items = (r.records ?? []).map((o) => {
    const phones = (o.phones ?? []).map((p) => normPhone(`${p.area ?? ""}${p.number ?? ""}`)).filter((p): p is string => !!p);
    const phone = phones.find(isMobile) ?? phones[0] ?? null;
    const email = (o.emails ?? []).find((e) => e.ownership !== "ACCOUNTING")?.address ?? null;
    const cnpj = o.taxId.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    return {
      key: `cnpj:${o.taxId}`,
      name: null,
      company: cut(o.alias || o.company?.name, 160),
      phone,
      mobile: isMobile(phone),
      email: cut(email, 254),
      segment: cut(o.mainActivity?.text, 80),
      city: cut(o.address?.city, 80),
      website: null,
      origin: `Receita Federal (CNPJ ${cnpj})`,
      info: [o.alias && o.company?.name ? o.company.name : null, `CNPJ ${cnpj}`, o.address?.district, o.founded ? `desde ${o.founded.slice(0, 4)}` : null].filter(Boolean).join(" · "),
    };
  });
  return { items: await mark(deps.sql, agencyId, items), next: r.next ?? null };
}

// ---------------------------------------------------------------------------
// Instagram (perfis comerciais, pela conta da Meta conectada)
// ---------------------------------------------------------------------------

export const instagramInput = z.object({
  usernames: z.array(z.string().trim().regex(/^@?[A-Za-z0-9._]{1,30}$/, "Use @perfil (letras, números, . e _).")).min(1, "Cole ao menos um @perfil.").max(50),
});

type Discovery = { business_discovery?: { username?: string; name?: string; biography?: string; website?: string; followers_count?: number } };

/** Telefone na bio ou no link (wa.me, api.whatsapp.com, números com DDD). */
export function phoneInText(text: string): string | null {
  const wa = text.match(/(?:wa\.me\/|whatsapp\.com\/send\?phone=)(\d{10,13})/i);
  if (wa) return normPhone(wa[1]);
  for (const m of text.matchAll(/(?:\+?55\s*)?\(?\d{2}\)?[\s.-]*9?\s*\d{4}[\s.-]?\d{4}/g)) {
    const p = normPhone(m[0]);
    if (p) return p;
  }
  return null;
}

export async function searchInstagram(deps: IntegrationDeps, agencyId: string, raw: unknown) {
  const input = instagramInput.parse(raw);
  const metas = await deps.sql.query<{ id: string }>(
    `select id from integration_connections where agency_id = $1 and provider = 'meta' and status = 'active' order by created_at desc`,
    [agencyId],
  );
  if (!metas.length) throw new XodoError("Conecte a Meta (Instagram e Facebook) em Integrações primeiro.", 409);
  let token = "", igId: string | null = null;
  for (const m of metas) {
    token = (await access(deps, agencyId, m.id)).accessToken;
    const pages = await requestJson<{ data?: { instagram_business_account?: { id: string } }[] }>(deps.fetch, `${metaGraph()}/me/accounts?fields=instagram_business_account&limit=100`, { bearer: token });
    igId = pages.data?.find((p) => p.instagram_business_account)?.instagram_business_account?.id ?? null;
    if (igId) break;
  }
  if (!igId) throw new XodoError("A conta da Meta conectada não tem um Instagram profissional ligado a uma página.", 409);
  const names = [...new Set(input.usernames.map((u) => u.replace(/^@/, "").toLowerCase()))];
  const items: Omit<Candidate, "exists" | "blocked">[] = [];
  const missing: string[] = [];
  for (const u of names) {
    try {
      const r = await requestJson<Discovery>(
        deps.fetch,
        `${metaGraph()}/${igId}?fields=${encodeURIComponent(`business_discovery.username(${u}){username,name,biography,website,followers_count}`)}`,
        { bearer: token },
      );
      const d = r.business_discovery;
      if (!d) { missing.push(u); continue; }
      const phone = phoneInText(`${d.biography ?? ""} ${d.website ?? ""}`);
      items.push({
        key: `ig:${u}`,
        name: null,
        company: cut(d.name || d.username, 160),
        phone,
        mobile: isMobile(phone),
        email: cut((d.biography ?? "").match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0], 254),
        segment: null,
        city: null,
        website: cut(d.website, 300),
        origin: `Instagram @${u}`,
        info: [`@${u}`, d.followers_count != null ? `${d.followers_count.toLocaleString("pt-BR")} seguidores` : null, phone ? null : "sem telefone na bio"].filter(Boolean).join(" · "),
      });
    } catch {
      // Perfil pessoal, inexistente ou privado: a Meta só mostra contas profissionais.
      missing.push(u);
    }
  }
  return { items: await mark(deps.sql, agencyId, items), missing };
}

// ---------------------------------------------------------------------------
// Grupos de WhatsApp (número ligado por QR Code)
// ---------------------------------------------------------------------------

export async function listGroups(deps: IntegrationDeps, agencyId: string) {
  const conns = await deps.sql.query<{ id: string; label: string }>(
    `select id, label from integration_connections where agency_id = $1 and provider = 'whatsapp_qr' and status = 'active' order by created_at`,
    [agencyId],
  );
  if (!conns.length) throw new XodoError("Ligue um número por QR Code em Xodós → Integrações → WhatsApp para ler os grupos.", 409);
  const out: { connection_id: string; number: string; groups: Awaited<ReturnType<typeof whatsappQrGroups>> }[] = [];
  for (const c of conns) out.push({ connection_id: c.id, number: c.label, groups: await whatsappQrGroups(deps, agencyId, c.id) });
  return out;
}

export const groupInput = z.object({ connection_id: z.uuid(), group_id: z.string().max(60), group_name: z.string().trim().max(100).default("grupo") });

export async function searchGroup(deps: IntegrationDeps, agencyId: string, raw: unknown) {
  const input = groupInput.parse(raw);
  const { phones, hidden } = await whatsappQrGroupMembers(deps, agencyId, input.connection_id, input.group_id);
  const seen = new Set<string>();
  const items: Omit<Candidate, "exists" | "blocked">[] = [];
  for (const raw of phones) {
    // O WhatsApp manda celular antigo sem o 9: põe de volta.
    const d = /^55\d{2}[6-9]\d{7}$/.test(raw) ? raw.slice(0, 4) + "9" + raw.slice(4) : raw;
    const phone = normPhone(d);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    items.push({ key: `wa:${phone}`, name: null, company: null, phone, mobile: isMobile(phone), email: null, segment: null, city: null, website: null, origin: `Grupo de WhatsApp "${input.group_name}"`, info: null });
  }
  return { items: await mark(deps.sql, agencyId, items), hidden };
}

/** O que a tela precisa saber antes: quais fontes estão prontas. */
export async function sourcesStatus(sql: Sql, agencyId: string) {
  const rows = await sql.query<{ provider: string; label: string }>(
    `select provider, label from integration_connections where agency_id = $1 and status = 'active' and provider in ('google_places', 'cnpja', 'meta', 'whatsapp_qr')`,
    [agencyId],
  );
  const has = (p: string) => rows.some((r) => r.provider === p);
  return { maps: has("google_places"), cnpj: has("cnpja"), instagram: has("meta"), groups: has("whatsapp_qr") };
}
