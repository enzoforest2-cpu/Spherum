import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";

/**
 * Cargos da agência. Cada cargo tem um nome livre e, para cada área do sistema, um nível:
 * nenhum (não vê), ver (só lê) ou editar (lê e altera, inclusive apagar). O dono da agência
 * não tem cargo e pode tudo. Ninguém dá a outra pessoa (nem a si) mais do que tem.
 */

export const AREAS = [
  { key: "clientes", label: "Clientes", hint: "Clientes, documentos e portal do cliente" },
  { key: "comercial", label: "Comercial", hint: "CRM, prospecção, propostas, formulários e agenda" },
  { key: "campanhas", label: "Campanhas e relatórios", hint: "Campanhas, performance, relatórios e riscos" },
  { key: "projetos", label: "Projetos e conteúdo", hint: "Projetos, tarefas, conteúdo, atas, chamados e automações" },
  { key: "financeiro", label: "Financeiro", hint: "Cobranças, notas, contratos, DRE e rentabilidade" },
  { key: "equipe", label: "Equipe", hint: "Pessoas, cargos, convites, academy e conquistas" },
  { key: "xodos", label: "Xodós", hint: "Criar, conversar e aprovar o que os xodós pedem" },
  { key: "configuracoes", label: "Integrações e configurações", hint: "Contas conectadas, canais, plano e dados da agência" },
] as const;
export type Area = (typeof AREAS)[number]["key"];
export const AREA_KEYS = AREAS.map((a) => a.key) as [Area, ...Area[]];
export const LEVELS = ["nenhum", "ver", "editar"] as const;
export type Level = (typeof LEVELS)[number];
export type Perms = Record<Area, Level>;
const RANK: Record<Level, number> = { nenhum: 0, ver: 1, editar: 2 };

export const FULL: Perms = Object.fromEntries(AREA_KEYS.map((k) => [k, "editar"])) as Perms;
export const NONE: Perms = Object.fromEntries(AREA_KEYS.map((k) => [k, "nenhum"])) as Perms;

/** Permissões completas (área que faltar vira "nenhum"; valor estranho também). */
export function normalizePerms(raw: unknown): Perms {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(AREA_KEYS.map((k) => [k, (LEVELS as readonly string[]).includes(String(src[k])) ? src[k] : "nenhum"])) as Perms;
}

export const atLeast = (have: Level, need: Level) => RANK[have] >= RANK[need];

/** O papel antigo (coluna role) que melhor descreve o cargo: mantém as regras e telas antigas coerentes. */
export function legacyRole(perms: Perms): "admin" | "member" | "viewer" | "financeiro" {
  if (perms.equipe === "editar" && perms.configuracoes === "editar") return "admin";
  const edits = AREA_KEYS.filter((k) => perms[k] === "editar");
  if (edits.length === 1 && edits[0] === "financeiro") return "financeiro";
  return edits.length ? "member" : "viewer";
}

export type Access = { owner: boolean; perms: Perms; roleId: string | null; roleName: string | null };

/** O que a pessoa pode na agência. Sem cargo (dados antigos), vale o papel antigo. */
export function accessOf(row: { role: string; perms: unknown | null; role_id: string | null; role_name: string | null }): Access {
  if (row.role === "owner") return { owner: true, perms: FULL, roleId: null, roleName: "Proprietário" };
  if (row.perms) return { owner: false, perms: normalizePerms(row.perms), roleId: row.role_id, roleName: row.role_name };
  const legacy: Record<string, Perms> = {
    admin: FULL,
    member: { ...FULL, financeiro: "ver", equipe: "ver", configuracoes: "ver" },
    financeiro: { ...NONE, clientes: "ver", comercial: "ver", projetos: "ver", financeiro: "editar", equipe: "ver", xodos: "ver" },
    viewer: { ...NONE, clientes: "ver", comercial: "ver", campanhas: "ver", projetos: "ver", equipe: "ver", xodos: "ver" },
  };
  return { owner: false, perms: legacy[row.role] ?? NONE, roleId: null, roleName: null };
}

export async function memberAccess(sql: Sql, agencyId: string, userId: string): Promise<Access | null> {
  const row = await one<{ role: string; perms: unknown | null; role_id: string | null; role_name: string | null }>(
    sql,
    `select m.role, r.perms, m.role_id, r.name as role_name
       from agency_members m left join agency_roles r on r.id = m.role_id
      where m.agency_id = $1 and m.user_id = $2`,
    [agencyId, userId],
  );
  return row ? accessOf(row) : null;
}

/** Quem não é dono só dá até o que ele mesmo tem, área por área. */
export function assertCanGrant(actor: Access, perms: Perms) {
  if (actor.owner) return;
  const over = AREAS.filter((a) => !atLeast(actor.perms[a.key], perms[a.key]));
  if (over.length) throw new XodoError(`Você não pode dar mais acesso do que tem. Veja: ${over.map((a) => a.label).join(", ")}.`, 403);
}

function assertTeamEditor(actor: Access) {
  if (!actor.owner && actor.perms.equipe !== "editar") throw new XodoError("Seu cargo não permite mudar a equipe nem os cargos.", 403);
}

// ---------------------------------------------------------------------------
// Cargos
// ---------------------------------------------------------------------------

const roleInput = z.object({
  name: z.string().trim().min(1, "Dê um nome ao cargo").max(40),
  description: z.string().trim().max(200).default(""),
  perms: z.record(z.string(), z.enum(LEVELS)),
});

export async function listRoles(sql: Sql, agencyId: string) {
  const rows = await sql.query<{ id: string; name: string; description: string; perms: unknown; preset: string | null; members: number }>(
    `select r.id, r.name, r.description, r.perms, r.preset, (select count(*)::int from agency_members m where m.role_id = r.id) as members
       from agency_roles r where r.agency_id = $1 order by r.position, lower(r.name)`,
    [agencyId],
  );
  return rows.map((r) => ({ ...r, perms: normalizePerms(r.perms) }));
}

const duplicate = (error: unknown) => (error as { code?: string }).code === "23505";

export async function createRole(sql: Sql, agencyId: string, actor: Access & { id: string }, raw: unknown) {
  assertTeamEditor(actor);
  const input = roleInput.parse(raw);
  const perms = normalizePerms(input.perms);
  assertCanGrant(actor, perms);
  const count = await one<{ n: number }>(sql, `select count(*)::int as n from agency_roles where agency_id = $1`, [agencyId]);
  if ((count?.n ?? 0) >= 40) throw new XodoError("Limite de 40 cargos por agência.", 429);
  try {
    const row = await one<{ id: string }>(
      sql,
      `insert into agency_roles (agency_id, name, description, perms, position)
       values ($1, $2, $3, $4::jsonb, (select coalesce(max(position), 0) + 1 from agency_roles where agency_id = $1)) returning id`,
      [agencyId, input.name, input.description, JSON.stringify(perms)],
    );
    await audit(sql, { agencyId, actor: actor.id, action: "cargo_criado", targetType: "cargo", targetId: row!.id, summary: input.name });
    return { id: row!.id, name: input.name, description: input.description, perms };
  } catch (error) {
    if (duplicate(error)) throw new XodoError("Já existe um cargo com esse nome.", 409);
    throw error;
  }
}

export async function updateRole(sql: Sql, agencyId: string, actor: Access & { id: string }, roleId: string, raw: unknown) {
  assertTeamEditor(actor);
  const input = roleInput.partial().parse(raw);
  const current = await one<{ perms: unknown }>(sql, `select perms from agency_roles where id = $1 and agency_id = $2`, [roleId, agencyId]);
  if (!current) throw new XodoError("Cargo não encontrado.", 404);
  // Mudar o próprio cargo seria se dar mais acesso: só o dono.
  if (!actor.owner && actor.roleId === roleId) throw new XodoError("Peça ao dono da agência para mudar o seu próprio cargo.", 403);
  assertCanGrant(actor, normalizePerms(current.perms));
  const perms = input.perms ? normalizePerms(input.perms) : null;
  if (perms) assertCanGrant(actor, perms);
  try {
    await sql.transaction(async (tx) => {
      await tx.query(
        `update agency_roles set name = coalesce($3, name), description = coalesce($4, description), perms = coalesce($5::jsonb, perms), updated_at = now()
          where id = $1 and agency_id = $2`,
        [roleId, agencyId, input.name ?? null, input.description ?? null, perms ? JSON.stringify(perms) : null],
      );
      if (perms) await tx.query(`update agency_members set role = $3 where agency_id = $1 and role_id = $2 and role <> 'owner'`, [agencyId, roleId, legacyRole(perms)]);
      await audit(tx, { agencyId, actor: actor.id, action: "cargo_alterado", targetType: "cargo", targetId: roleId, summary: input.name ?? "" });
    });
  } catch (error) {
    if (duplicate(error)) throw new XodoError("Já existe um cargo com esse nome.", 409);
    throw error;
  }
  return { ok: true };
}

/** Apaga o cargo. Se alguém usa, precisa dizer para qual cargo essas pessoas vão (mover_para). */
export async function deleteRole(sql: Sql, agencyId: string, actor: Access & { id: string }, roleId: string, moveTo: string | null) {
  assertTeamEditor(actor);
  return sql.transaction(async (tx) => {
    const role = await one<{ perms: unknown; name: string; members: number }>(
      tx,
      `select perms, name, (select count(*)::int from agency_members m where m.role_id = r.id) as members from agency_roles r where id = $1 and agency_id = $2 for update`,
      [roleId, agencyId],
    );
    if (!role) throw new XodoError("Cargo não encontrado.", 404);
    if (!actor.owner && actor.roleId === roleId) throw new XodoError("Você não pode apagar o seu próprio cargo.", 403);
    assertCanGrant(actor, normalizePerms(role.perms));
    if (role.members > 0) {
      if (!moveTo) throw new XodoError(`${role.members} ${role.members === 1 ? "pessoa usa" : "pessoas usam"} este cargo. Escolha para qual cargo ${role.members === 1 ? "ela vai" : "elas vão"}.`, 409);
      const target = await one<{ perms: unknown }>(tx, `select perms from agency_roles where id = $1 and agency_id = $2 and id <> $3`, [moveTo, agencyId, roleId]);
      if (!target) throw new XodoError("Cargo de destino não encontrado.", 404);
      assertCanGrant(actor, normalizePerms(target.perms));
      await tx.query(`update agency_members set role_id = $3, role = $4 where agency_id = $1 and role_id = $2`, [agencyId, roleId, moveTo, legacyRole(normalizePerms(target.perms))]);
    }
    await tx.query(`update invites set role_id = $3 where agency_id = $1 and role_id = $2 and accepted_at is null`, [agencyId, roleId, moveTo]);
    await tx.query(`delete from agency_roles where id = $1`, [roleId]);
    await audit(tx, { agencyId, actor: actor.id, action: "cargo_apagado", targetType: "cargo", targetId: roleId, summary: role.name });
    return { ok: true };
  });
}

/** Cargo pronto, por nome antigo de papel (convites e chamadas antigas). */
export async function roleIdForLegacy(sql: Sql, agencyId: string, legacy: string): Promise<string | null> {
  const preset = ({ admin: "administrador", member: "gestor", financeiro: "financeiro", viewer: "leitor" } as Record<string, string>)[legacy];
  if (!preset) return null;
  return (await one<{ id: string }>(sql, `select id from agency_roles where agency_id = $1 and preset = $2 order by position limit 1`, [agencyId, preset]))?.id ?? null;
}

export async function rolePerms(sql: Sql, agencyId: string, roleId: string): Promise<Perms> {
  const row = await one<{ perms: unknown }>(sql, `select perms from agency_roles where id = $1 and agency_id = $2`, [roleId, agencyId]);
  if (!row) throw new XodoError("Cargo não encontrado.", 404);
  return normalizePerms(row.perms);
}
