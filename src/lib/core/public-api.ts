import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import { createDeal, OPEN_STAGES, STAGES } from "./crm";
import { importLeads } from "./prospect";
import { apiEnabled } from "./subscription";

/**
 * API pública (v1) para quem integra com o Spherum: chave por agência ("Authorization: Bearer
 * sph_live_…"), sem login do Supabase. Os nomes de campo são estáveis, em inglês snake_case; os
 * valores de status e etapa são os mesmos do app (ativo, proposta, respondeu…). Erros: {error}.
 *
 * - Escopos: read (lê) e write (cria negócios e leads). write sem read não existe.
 * - Limite: 120 pedidos por minuto por chave, contados no banco.
 * - Agência suspensa: nada. Bloqueada pela cobrança: só leitura (como no app).
 * - A API sai do plano (desceu de plano, tirou o add-on): as chaves param até voltar.
 */

export const API_RATE_PER_MIN = 120;
export const API_PAGE = { default: 50, max: 100 };
const KEY_PREFIX = "sph_live_";
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Erro da API com cabeçalhos extras (ex.: Retry-After no 429). */
export class ApiError extends XodoError {
  constructor(message: string, status: number, readonly headers: Record<string, string> = {}) {
    super(message, status);
  }
}

// ---------------------------------------------------------------------------
// Chaves (tela da agência)
// ---------------------------------------------------------------------------

export const apiKeyInput = z.object({
  name: z.string().trim().min(1, "Dê um nome à chave").max(80),
  scopes: z.array(z.enum(["read", "write"])).min(1).max(2).default(["read"]),
});

const NOT_IN_PLAN = `API e webhooks vêm no plano Rede (ou com o add-on "API e webhooks" no Escala). Veja em Configurações → Plano e cobrança.`;

export async function listApiKeys(sql: Sql, agencyId: string) {
  return sql.query<{ id: string; name: string; prefix: string; scopes: string[]; created_by: string; created_by_name: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
    `select k.id, k.name, k.prefix, k.scopes, k.created_by, p.full_name as created_by_name, k.created_at::text, k.last_used_at::text, k.revoked_at::text
       from api_keys k left join profiles p on p.id = k.created_by where k.agency_id = $1 order by k.revoked_at is not null, k.created_at desc`,
    [agencyId],
  );
}

/** Cria a chave. A chave inteira volta só aqui; o banco guarda o sha256 e o prefixo. */
export async function createApiKey(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = apiKeyInput.parse(raw);
  if (!(await apiEnabled(sql, agencyId))) throw new XodoError(NOT_IN_PLAN, 402);
  const active = await one<{ n: number }>(sql, `select count(*)::int as n from api_keys where agency_id = $1 and revoked_at is null`, [agencyId]);
  if ((active?.n ?? 0) >= 20) throw new XodoError("Limite de 20 chaves ativas. Revogue uma que não usa mais.", 409);
  // Escrever inclui ler.
  const scopes = input.scopes.includes("write") ? ["read", "write"] : ["read"];
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const row = await one<{ id: string; created_at: string }>(sql,
    `insert into api_keys (agency_id, name, prefix, key_hash, scopes, created_by) values ($1, $2, $3, $4, $5::text[], $6) returning id, created_at::text`,
    [agencyId, input.name, key.slice(0, KEY_PREFIX.length + 4), hashKey(key), scopes, userId]);
  await audit(sql, { agencyId, actor: userId, action: "chave_api_criada", targetType: "api_key", targetId: row!.id, summary: input.name });
  return { id: row!.id, name: input.name, prefix: key.slice(0, KEY_PREFIX.length + 4), scopes, created_at: row!.created_at, key };
}

export async function revokeApiKey(sql: Sql, agencyId: string, userId: string, id: string) {
  const row = await one<{ name: string }>(sql,
    `update api_keys set revoked_at = coalesce(revoked_at, now()) where id = $1 and agency_id = $2 returning name`, [id, agencyId]);
  if (!row) throw new XodoError("Chave não encontrada.", 404);
  await audit(sql, { agencyId, actor: userId, action: "chave_api_revogada", targetType: "api_key", targetId: id, summary: row.name });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Autenticação das rotas /api/v1
// ---------------------------------------------------------------------------

export type ApiCtx = { keyId: string; agencyId: string; userId: string; scopes: string[] };

/**
 * Confere a chave do cabeçalho, o plano, a situação da agência e o limite de taxa; marca o último uso.
 * need: "read" para ler, "write" para criar.
 */
export async function apiAuth(sql: Sql, request: Request, need: "read" | "write", now = new Date()): Promise<ApiCtx> {
  const key = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key || !key.startsWith(KEY_PREFIX)) throw new ApiError("Mande a chave em Authorization: Bearer sph_live_…", 401);
  const k = await one<{ id: string; agency_id: string; created_by: string; scopes: string[]; revoked: boolean; member: boolean; suspended: boolean; locked: boolean }>(sql,
    `select k.id, k.agency_id, k.created_by, k.scopes, k.revoked_at is not null as revoked,
            exists(select 1 from agency_members m where m.agency_id = k.agency_id and m.user_id = k.created_by) as member,
            a.suspended_at is not null as suspended, a.locked_at is not null as locked
       from api_keys k join agencies a on a.id = k.agency_id where k.key_hash = $1`,
    [hashKey(key)]);
  // Mesmo erro para chave que não existe e chave revogada.
  if (!k || k.revoked) throw new ApiError("Chave de API inválida ou revogada.", 401);
  // Quem criou a chave saiu da agência: a chave cai junto.
  if (!k.member) throw new ApiError("Chave de API inválida ou revogada.", 401);
  if (k.suspended) throw new ApiError("Esta agência está suspensa. Fale com o suporte do Spherum (suporte@spherum.com.br).", 403);
  if (!(await apiEnabled(sql, k.agency_id))) throw new ApiError(NOT_IN_PLAN, 402);
  if (!k.scopes.includes(need)) throw new ApiError(need === "write" ? "Esta chave só lê. Crie uma chave com o escopo write." : "Esta chave não pode ler.", 403);
  if (need === "write" && k.locked) throw new ApiError("A agência está bloqueada pela cobrança do Spherum: a API só lê até a fatura ser paga.", 402);
  const hit = await one<{ hits: number }>(sql,
    `insert into api_key_hits (key_id, minute, hits) values ($1, date_trunc('minute', $2::timestamptz), 1)
     on conflict (key_id, minute) do update set hits = api_key_hits.hits + 1 returning hits`,
    [k.id, now.toISOString()]);
  if ((hit?.hits ?? 0) > API_RATE_PER_MIN) {
    const wait = 60 - now.getUTCSeconds();
    throw new ApiError(`Limite de ${API_RATE_PER_MIN} pedidos por minuto por chave. Tente de novo em ${wait}s.`, 429, { "retry-after": String(wait) });
  }
  // Último uso com precisão de um minuto: evita uma gravação a cada pedido.
  await sql.query(`update api_keys set last_used_at = $2::timestamptz where id = $1 and (last_used_at is null or last_used_at < $2::timestamptz - interval '1 minute')`,
    [k.id, now.toISOString()]);
  return { keyId: k.id, agencyId: k.agency_id, userId: k.created_by, scopes: k.scopes };
}

/** Resposta de erro da API: sempre {error}. */
export function apiFail(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status, headers: error.headers });
  if (error instanceof XodoError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) {
    const i = error.issues[0];
    return NextResponse.json({ error: i ? `Dados inválidos${i.path.length ? ` em ${i.path.join(".")}` : ""}: ${i.message}` : "Dados inválidos" }, { status: 400 });
  }
  if (error instanceof SyntaxError) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  console.error("[api v1]", error);
  return NextResponse.json({ error: "Erro interno" }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Paginação por cursor (mais novos primeiro)
// ---------------------------------------------------------------------------

const pageInput = z.object({
  limit: z.coerce.number().int().min(1).max(API_PAGE.max).default(API_PAGE.default),
  cursor: z.string().max(200).optional(),
});

const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)$/;

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && TS.test(v[0]) && z.uuid().safeParse(v[1]).success) return [v[0], v[1]];
  } catch {}
  throw new XodoError("Cursor inválido.", 400);
}
const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");

type Page<T> = { data: T[]; has_more: boolean; next_cursor: string | null };

/**
 * Lista paginada. A consulta recebe o filtro do cursor já pronto ("and (col, id) < (…)") e precisa
 * devolver a coluna de ordenação em _at e o id; pede limit + 1 para saber se há mais.
 */
type ApiRow = Record<string, unknown> & { id: string; _at: string };

async function paged<T extends ApiRow = ApiRow>(
  sql: Sql, params: URLSearchParams, build: (cursorSql: string) => { text: string; values: unknown[] }, orderCol: string,
): Promise<Page<Omit<T, "_at">>> {
  const p = pageInput.parse({ limit: params.get("limit") ?? undefined, cursor: params.get("cursor") ?? undefined });
  const cur = decodeCursor(p.cursor);
  const q = build(cur ? `and (${orderCol}, x.id) < ($CUR_AT::timestamptz, $CUR_ID::uuid)` : "");
  let values = q.values;
  let text = q.text;
  if (cur) {
    values = [...values, cur[0], cur[1]];
    text = text.replace("$CUR_AT", `$${values.length - 1}`).replace("$CUR_ID", `$${values.length}`);
  }
  values = [...values, p.limit + 1];
  text = `${text} order by ${orderCol} desc, x.id desc limit $${values.length}`;
  const rows = await sql.query<T>(text, values);
  const more = rows.length > p.limit;
  const page = rows.slice(0, p.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => {
      const { _at: _drop, ...rest } = r;
      void _drop;
      return rest;
    }),
    has_more: more,
    next_cursor: more && last ? encodeCursor(last._at, last.id) : null,
  };
}

const bool = (v: string | null) => v === "1" || v === "true";

// ---------------------------------------------------------------------------
// Recursos
// ---------------------------------------------------------------------------

const CLIENT_COLS = `x.id, x.name, x.segment, x.status, x.monthly_fee_cents::float8 as monthly_fee_cents, x.started_on::text, x.website, x.instagram,
  x.cnpj as document, x.city, x.owner_user_id, x.goal_metric, x.goal_value::float8 as goal_value, x.health_score,
  x.archived_at::text, x.created_at::text, x.updated_at::text, x.created_at::text as _at,
  (select json_build_object('name', ct.name, 'email', ct.email, 'phone', ct.phone)
     from client_contacts ct where ct.client_id = x.id order by ct.is_primary desc, ct.created_at limit 1) as primary_contact`;

/** GET /api/v1/clients  ?status=ativo&include_archived=true&limit=&cursor= */
export async function apiListClients(sql: Sql, ctx: ApiCtx, params: URLSearchParams) {
  const status = z.enum(["ativo", "onboarding", "pausado", "encerrado"]).optional().parse(params.get("status") ?? undefined);
  return paged(sql, params, (c) => ({
    text: `select ${CLIENT_COLS} from clients x where x.agency_id = $1 and ($2::text is null or x.status = $2) and ($3 or x.archived_at is null) ${c}`,
    values: [ctx.agencyId, status ?? null, bool(params.get("include_archived"))],
  }), "x.created_at");
}

export async function apiGetClient(sql: Sql, ctx: ApiCtx, id: string): Promise<Record<string, unknown>> {
  if (!z.uuid().safeParse(id).success) throw new XodoError("Cliente não encontrado.", 404);
  const row = await one<Record<string, unknown>>(sql, `select ${CLIENT_COLS} from clients x where x.id = $1 and x.agency_id = $2`, [id, ctx.agencyId]);
  if (!row) throw new XodoError("Cliente não encontrado.", 404);
  delete row._at;
  const contacts = await sql.query(
    `select id, name, email, phone, role, is_primary from client_contacts where client_id = $1 and agency_id = $2 order by is_primary desc, created_at`,
    [id, ctx.agencyId]);
  return { ...row, contacts };
}

const DEAL_COLS = `x.id, x.company, x.contact_name, x.email, x.phone, x.segment, x.website, x.source, x.value_cents::float8 as value_cents, x.stage,
  x.owner_user as owner_user_id, x.next_action, x.next_action_date::text, x.notes, x.client_id, x.won_at::text, x.lost_at::text, x.lost_reason,
  x.created_at::text, x.updated_at::text, x.created_at::text as _at`;

/** GET /api/v1/deals  ?stage=proposta&limit=&cursor= */
export async function apiListDeals(sql: Sql, ctx: ApiCtx, params: URLSearchParams) {
  const stage = z.enum(STAGES).optional().parse(params.get("stage") ?? undefined);
  return paged(sql, params, (c) => ({
    text: `select ${DEAL_COLS} from deals x where x.agency_id = $1 and ($2::text is null or x.stage = $2) ${c}`,
    values: [ctx.agencyId, stage ?? null],
  }), "x.created_at");
}

export const apiDealInput = z.object({
  company: z.string().trim().min(1).max(160),
  contact_name: z.string().trim().max(120).nullish(),
  email: z.email().trim().toLowerCase().max(254).nullish(),
  phone: z.string().trim().max(40).nullish(),
  segment: z.string().trim().max(80).nullish(),
  website: z.string().trim().max(200).nullish(),
  source: z.string().trim().max(40).nullish(),
  value_cents: z.number().int().min(0).max(100_000_000).optional(),
  stage: z.enum(OPEN_STAGES as unknown as [string, ...string[]]).optional(),
  owner_user_id: z.uuid().nullish(),
  next_action: z.string().trim().max(200).nullish(),
  next_action_date: z.iso.date().nullish(),
  notes: z.string().trim().max(4000).nullish(),
}).strict();

/** POST /api/v1/deals  negócio novo no funil (origem "api" se não vier outra). */
export async function apiCreateDeal(sql: Sql, ctx: ApiCtx, raw: unknown) {
  const { value_cents, owner_user_id, source, ...rest } = apiDealInput.parse(raw);
  const created = await createDeal(sql, ctx.agencyId, ctx.userId, {
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
    source: source ?? "api",
    value: value_cents != null ? value_cents / 100 : undefined,
    // Sem responsável, o negócio fica sem dono (não cai em quem criou a chave).
    owner_user: owner_user_id ?? null,
  });
  const row = await one<Record<string, unknown>>(sql, `select ${DEAL_COLS} from deals x where x.id = $1 and x.agency_id = $2`, [created.id, ctx.agencyId]);
  delete row!._at;
  return row!;
}

const LEAD_COLS = `x.id, x.list_name as list, x.name, x.company, x.phone, x.email, x.segment, x.city, x.website, x.source, x.origin, x.stage,
  x.last_out_at::text, x.last_in_at::text, x.deal_id, x.created_at::text, x.updated_at::text, x.created_at::text as _at`;

/** GET /api/v1/leads  ?stage=respondeu&list=Evento&limit=&cursor= */
export async function apiListLeads(sql: Sql, ctx: ApiCtx, params: URLSearchParams) {
  const stage = z.string().max(20).optional().parse(params.get("stage") ?? undefined);
  const list = z.string().max(80).optional().parse(params.get("list") ?? undefined);
  return paged(sql, params, (c) => ({
    text: `select ${LEAD_COLS} from prospect_leads x where x.agency_id = $1 and ($2::text is null or x.stage = $2) and ($3::text is null or x.list_name = $3) ${c}`,
    values: [ctx.agencyId, stage ?? null, list ?? null],
  }), "x.created_at");
}

export const apiLeadsInput = z.object({
  list: z.string().trim().min(1).max(80),
  // Quem integra confirma que os contatos podem receber mensagem (como na importação do app).
  consent: z.literal(true, { error: "Confirme (consent: true) que esses contatos podem receber mensagem." }),
  leads: z.array(z.object({
    phone: z.string().max(40),
    name: z.string().trim().max(120).optional(),
    company: z.string().trim().max(160).optional(),
    email: z.string().trim().max(254).optional(),
    segment: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    website: z.string().trim().max(300).optional(),
  }).strict()).min(1).max(100),
}).strict();

/** POST /api/v1/leads  importa para a lista, pulando inválidos, repetidos e bloqueados (pediram para sair). */
export async function apiCreateLeads(sql: Sql, ctx: ApiCtx, raw: unknown) {
  const input = apiLeadsInput.parse(raw);
  const r = await importLeads(sql, ctx.agencyId, ctx.userId, { list: input.list, source: "manual", rows: input.leads, consent: true });
  return { added: r.added, invalid: r.bad, duplicates: r.dup, blocked: r.blocked };
}

/** GET /api/v1/reports  relatórios publicados  ?client_id=&limit=&cursor= */
export async function apiListReports(sql: Sql, ctx: ApiCtx, params: URLSearchParams) {
  const clientId = z.uuid().optional().parse(params.get("client_id") ?? undefined);
  return paged(sql, params, (c) => ({
    text: `select x.id, x.client_id, x.title, x.period_start::text, x.period_end::text, x.body_md, x.published_at::text, x.created_at::text,
                  x.published_at::text as _at
             from reports x where x.agency_id = $1 and x.status = 'published' and x.published_at is not null and ($2::uuid is null or x.client_id = $2) ${c}`,
    values: [ctx.agencyId, clientId ?? null],
  }), "x.published_at");
}

const metricsInput = z.object({ from: z.iso.date(), to: z.iso.date() });

/** GET /api/v1/clients/:id/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD  (até 366 dias; padrão: últimos 30) */
export async function apiClientMetrics(sql: Sql, ctx: ApiCtx, clientId: string, params: URLSearchParams, now = new Date()) {
  if (!z.uuid().safeParse(clientId).success) throw new XodoError("Cliente não encontrado.", 404);
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const { from, to } = metricsInput.parse({ from: params.get("from") ?? day(new Date(now.getTime() - 29 * 864e5)), to: params.get("to") ?? day(now) });
  if (to < from) throw new XodoError("O fim (to) vem depois do início (from).", 400);
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 365) throw new XodoError("Intervalo de no máximo 366 dias.", 400);
  const client = await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [clientId, ctx.agencyId]);
  if (!client) throw new XodoError("Cliente não encontrado.", 404);
  const rows = await sql.query<Record<string, unknown>>(
    `select day::text as date, platform, sum(spend_cents) as spend_cents, sum(impressions) as impressions, sum(clicks) as clicks,
            sum(leads) as leads, sum(conversions) as conversions, sum(revenue_cents) as revenue_cents
       from metrics_daily where agency_id = $1 and client_id = $2 and day between $3::date and $4::date
      group by day, platform order by day, platform`,
    [ctx.agencyId, clientId, from, to]);
  const N = ["spend_cents", "impressions", "clicks", "leads", "conversions", "revenue_cents"];
  return { client_id: clientId, from, to, data: rows.map((r) => ({ ...r, ...Object.fromEntries(N.map((k) => [k, num(r[k])])) })) };
}
