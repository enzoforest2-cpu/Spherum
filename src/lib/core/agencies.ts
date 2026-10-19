import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import type { Role } from "../xodos/http";
import { audit } from "./audit";

/**
 * Agências e quem é quem: a pessoa que se cadastra cria a agência e vira dona; o resto da
 * equipe entra por convite (team.ts). Toda leitura de dados de negócio filtra pela agência.
 */

export const PLANS = ["solo", "agencia", "escala", "rede", "empresarial"] as const;
export type Plan = (typeof PLANS)[number];

const UF = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Respostas do cadastro em 5 passos (passos 2 a 5 do design). Tudo opcional menos o nome:
 * o resto vira o perfil da agência e ajuda a recomendar o plano.
 */
export const agencyInput = z.object({
  name: z.string().trim().min(1).max(120),
  website: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  state: UF.optional(),
  city: z.string().trim().max(80).optional(),
  plan: z.enum(PLANS).optional(),
  billing_cycle: z.enum(["mensal", "anual"]).optional(),
  onboarding: z
    .object({
      mode: z.enum(["solo", "team", "agency"]).optional(),
      clients: z.string().max(40).optional(),
      team: z.string().max(40).optional(),
      invest: z.string().max(40).optional(),
      plats: z.array(z.string().max(40)).max(10).optional(),
      tools: z.array(z.string().max(40)).max(20).optional(),
      goals: z.array(z.string().max(80)).max(5).optional(),
      rev: z.string().max(40).optional(),
      recommended_plan: z.enum(PLANS).optional(),
      coupon: z.string().max(40).optional(),
    })
    .partial()
    .optional(),
});

export const agencyPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    website: z.string().trim().max(200).nullable(),
    phone: z.string().trim().max(40).nullable(),
    city: z.string().trim().max(80).nullable(),
    state: UF.nullable(),
    cnpj: z
      .string()
      .transform(digits)
      .pipe(z.string().regex(/^\d{14}$/, "CNPJ precisa ter 14 dígitos"))
      .nullable(),
    brand_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
    timezone: z.string().trim().min(1).max(60),
  })
  .partial();

/** Endereço curto e único (minúsculas, sem acento), usado no portal do cliente. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return base || "agencia";
}

async function freeSlug(sql: Sql, name: string): Promise<string> {
  const base = slugify(name);
  const taken = await sql.query<{ slug: string }>(`select slug from agencies where slug = $1 or slug like $2`, [base, `${base}-%`]);
  const used = new Set(taken.map((t) => t.slug));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

/** Cria a agência com a pessoa como dona (uma transação: nunca fica agência sem dono). */
export async function createAgency(sql: Sql, userId: string, raw: unknown) {
  const input = agencyInput.parse(raw);
  // Limite simples contra abuso: ninguém é dono de mais de 5 agências.
  const owned = await one<{ n: number }>(sql, `select count(*)::int as n from agency_members where user_id = $1 and role = 'owner'`, [userId]);
  if ((owned?.n ?? 0) >= 5) throw new XodoError("Você já é dono de 5 agências. Fale com o suporte para criar mais.", 409);
  return sql.transaction(async (tx) => {
    const agency = await one<{ id: string; name: string; slug: string }>(
      tx,
      `insert into agencies (name, slug, website, phone, state, city, plan, billing_cycle, onboarding, created_by)
       values ($1, $2, $3, $4, $5, $6, coalesce($7, 'agencia'), coalesce($8, 'mensal'), $9::jsonb, $10)
       returning id, name, slug`,
      [input.name, await freeSlug(tx, input.name), input.website || null, input.phone || null, input.state ?? null, input.city || null,
        input.plan ?? input.onboarding?.recommended_plan ?? null, input.billing_cycle ?? null, json(input.onboarding ?? {}), userId],
    );
    await tx.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'owner')`, [agency!.id, userId]);
    await audit(tx, { agencyId: agency!.id, actor: userId, action: "agencia_criada", targetType: "agency", targetId: agency!.id });
    return agency!;
  });
}

export async function getAgency(sql: Sql, agencyId: string) {
  const agency = await one(
    sql,
    `select id, name, slug, plan, plan_status, trial_ends_at::text, billing_cycle, cnpj, phone, website, city, state, logo_path,
            brand_color, timezone, onboarding, created_at::text
       from agencies where id = $1`,
    [agencyId],
  );
  if (!agency) throw new XodoError("Não encontrado", 404);
  return agency;
}

export async function updateAgency(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = agencyPatch.parse(raw);
  const keys = Object.keys(input) as (keyof typeof input)[];
  if (!keys.length) return getAgency(sql, agencyId);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await sql.query(`update agencies set ${sets} where id = $1`, [agencyId, ...keys.map((k) => input[k] ?? null)]);
  await audit(sql, { agencyId, actor: userId, action: "agencia_alterada", targetType: "agency", targetId: agencyId, summary: keys.join(", ") });
  return getAgency(sql, agencyId);
}

export type Membership = { agency_id: string; name: string; slug: string | null; role: Role; plan: Plan; plan_status: string };
export type PortalAccess = { client_id: string; client_name: string; agency_id: string; agency_name: string };

/**
 * Quem é a pessoa: perfil, agências (com papel), acessos de portal de cliente e se é da equipe
 * do Spherum. O front decide por aqui qual portal abrir depois do login.
 */
export async function me(sql: Sql, user: { id: string; email: string | null }) {
  const [profile, agencies, portals, staff] = await Promise.all([
    one<{ full_name: string | null; phone: string | null }>(sql, `select full_name, phone from profiles where id = $1`, [user.id]),
    sql.query<Membership>(
      `select a.id as agency_id, a.name, a.slug, m.role, a.plan, a.plan_status
         from agency_members m join agencies a on a.id = m.agency_id
        where m.user_id = $1 order by m.created_at`,
      [user.id],
    ),
    sql.query<PortalAccess>(
      `select c.id as client_id, c.name as client_name, a.id as agency_id, a.name as agency_name
         from client_portal_users u join clients c on c.id = u.client_id join agencies a on a.id = u.agency_id
        where u.user_id = $1 and c.archived_at is null order by u.created_at`,
      [user.id],
    ),
    one<{ role: string }>(sql, `select role from spherum_staff where user_id = $1`, [user.id]),
  ]);
  const home = staff ? "admin" : agencies.length ? "agencia" : portals.length ? "cliente" : "cadastro";
  return { user: { id: user.id, email: user.email, full_name: profile?.full_name ?? null, phone: profile?.phone ?? null }, agencies, portals, staff: staff?.role ?? null, home };
}

export async function updateProfile(sql: Sql, userId: string, raw: unknown) {
  const input = z.object({ full_name: z.string().trim().min(1).max(120), phone: z.string().trim().max(40).nullable() }).partial().parse(raw);
  await sql.query(
    `insert into profiles (id, full_name, phone) values ($1, $2, $3)
     on conflict (id) do update set full_name = coalesce($2, profiles.full_name), phone = case when $4 then $3 else profiles.phone end`,
    [userId, input.full_name ?? null, input.phone ?? null, "phone" in input],
  );
}
