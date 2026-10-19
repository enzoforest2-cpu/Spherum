import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import type { Role } from "../xodos/http";
import { audit } from "./audit";

/**
 * Equipe da agência e convites por link. O convite vale para um e-mail: só quem entra com
 * aquele e-mail aceita. Só o hash do token fica no banco; o link vai uma vez para quem convidou.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEAM_ROLES = ["admin", "member", "viewer", "financeiro"] as const;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const nowOf = (now?: () => Date) => (now ? now() : new Date());

export async function listMembers(sql: Sql, agencyId: string) {
  return sql.query(
    `select m.user_id, m.role, m.title, m.created_at::text, p.full_name, u.email
       from agency_members m
       left join profiles p on p.id = m.user_id
       left join auth.users u on u.id = m.user_id
      where m.agency_id = $1
      order by case m.role when 'owner' then 0 when 'admin' then 1 when 'financeiro' then 2 when 'member' then 3 else 4 end, m.created_at`,
    [agencyId],
  );
}

async function ownerCount(sql: Sql, agencyId: string) {
  return (await one<{ n: number }>(sql, `select count(*)::int as n from agency_members where agency_id = $1 and role = 'owner'`, [agencyId]))!.n;
}

/**
 * Troca papel ou cargo. Owner pode tudo (inclusive passar a posse); admin mexe em member e
 * viewer. A agência nunca fica sem dono.
 */
export async function updateMember(
  sql: Sql,
  agencyId: string,
  actor: { id: string; role: Role },
  targetId: string,
  raw: unknown,
) {
  const input = z.object({ role: z.enum(["owner", "admin", "member", "viewer", "financeiro"]), title: z.string().trim().max(80).nullable() }).partial().parse(raw);
  return sql.transaction(async (tx) => {
    const target = await one<{ role: Role }>(tx, `select role from agency_members where agency_id = $1 and user_id = $2 for update`, [agencyId, targetId]);
    if (!target) throw new XodoError("Pessoa não encontrada na equipe.", 404);
    if (input.role && input.role !== target.role) {
      const touchesTop = target.role === "owner" || input.role === "owner" || target.role === "admin" || input.role === "admin";
      if (actor.role !== "owner" && touchesTop) throw new XodoError("Só o dono da agência muda papéis de dono e de admin.", 403);
      if (target.role === "owner" && (await ownerCount(tx, agencyId)) <= 1) {
        throw new XodoError("A agência precisa de pelo menos um dono. Passe a posse para outra pessoa antes.", 409);
      }
    }
    if (input.title !== undefined && actor.id !== targetId && actor.role !== "owner" && actor.role !== "admin") {
      throw new XodoError("Seu papel na agência não permite esta ação.", 403);
    }
    await tx.query(
      `update agency_members set role = coalesce($3, role), title = case when $5 then $4 else title end where agency_id = $1 and user_id = $2`,
      [agencyId, targetId, input.role ?? null, input.title ?? null, input.title !== undefined],
    );
    if (input.role && input.role !== target.role) {
      await audit(tx, { agencyId, actor: actor.id, action: "papel_alterado", targetType: "member", targetId, summary: `${target.role} → ${input.role}` });
    }
  });
}

/** Tira alguém da equipe (ou a própria pessoa sai). O último dono não sai. */
export async function removeMember(sql: Sql, agencyId: string, actor: { id: string; role: Role }, targetId: string) {
  return sql.transaction(async (tx) => {
    const target = await one<{ role: Role }>(tx, `select role from agency_members where agency_id = $1 and user_id = $2 for update`, [agencyId, targetId]);
    if (!target) throw new XodoError("Pessoa não encontrada na equipe.", 404);
    const self = actor.id === targetId;
    if (!self) {
      if (actor.role !== "owner" && actor.role !== "admin") throw new XodoError("Seu papel na agência não permite esta ação.", 403);
      if (actor.role !== "owner" && (target.role === "owner" || target.role === "admin")) {
        throw new XodoError("Só o dono da agência tira donos e admins.", 403);
      }
    }
    if (target.role === "owner" && (await ownerCount(tx, agencyId)) <= 1) {
      throw new XodoError("A agência precisa de pelo menos um dono. Passe a posse para outra pessoa antes.", 409);
    }
    await tx.query(`delete from agency_members where agency_id = $1 and user_id = $2`, [agencyId, targetId]);
    await audit(tx, { agencyId, actor: actor.id, action: self ? "saiu_da_agencia" : "membro_removido", targetType: "member", targetId });
  });
}

// ---------------------------------------------------------------------------
// Convites
// ---------------------------------------------------------------------------

export const inviteInput = z.object({
  email: z.email().trim().toLowerCase().max(254),
  role: z.enum(TEAM_ROLES).default("member"),
});

export type CreatedInvite = { id: string; email: string; role: string; expires_at: string; token: string };

async function insertInvite(
  sql: Sql,
  o: { agencyId: string; kind: "equipe" | "cliente"; clientId: string | null; email: string; role: string; actor: string; now?: () => Date },
): Promise<CreatedInvite> {
  const token = randomBytes(24).toString("base64url");
  const now = nowOf(o.now);
  return sql.transaction(async (tx) => {
    // Convite novo para o mesmo e-mail substitui o anterior ainda aberto.
    await tx.query(
      `update invites set revoked_at = $4::timestamptz
        where agency_id = $1 and lower(email) = $2 and coalesce(client_id::text, '') = coalesce($3::text, '')
          and accepted_at is null and revoked_at is null`,
      [o.agencyId, o.email, o.clientId, now.toISOString()],
    );
    const row = await one<{ id: string; expires_at: string }>(
      tx,
      `insert into invites (agency_id, kind, client_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz) returning id, expires_at::text`,
      [o.agencyId, o.kind, o.clientId, o.email, o.role, hashToken(token), o.actor, new Date(now.getTime() + INVITE_TTL_MS).toISOString()],
    );
    await audit(tx, { agencyId: o.agencyId, actor: o.actor, action: "convite_criado", targetType: o.kind, targetId: row!.id, summary: o.role });
    return { id: row!.id, email: o.email, role: o.role, expires_at: row!.expires_at, token };
  });
}

/** Convida para a equipe. Admin não convida admin (só o dono). */
export async function inviteMember(sql: Sql, agencyId: string, actor: { id: string; role: Role }, raw: unknown, now?: () => Date) {
  const input = inviteInput.parse(raw);
  if (input.role === "admin" && actor.role !== "owner") throw new XodoError("Só o dono da agência convida admins.", 403);
  const already = await one(
    sql,
    `select 1 from agency_members m join auth.users u on u.id = m.user_id where m.agency_id = $1 and lower(u.email) = $2`,
    [agencyId, input.email],
  );
  if (already) throw new XodoError("Essa pessoa já está na equipe.", 409);
  const pending = await one<{ n: number }>(
    sql,
    `select count(*)::int as n from invites where agency_id = $1 and accepted_at is null and revoked_at is null and expires_at > $2::timestamptz`,
    [agencyId, nowOf(now).toISOString()],
  );
  if ((pending?.n ?? 0) >= 50) throw new XodoError("Há convites demais em aberto. Cancele alguns antes.", 429);
  return insertInvite(sql, { agencyId, kind: "equipe", clientId: null, email: input.email, role: input.role, actor: actor.id, now });
}

/** Dá a alguém do cliente acesso ao portal do cliente (só o que é daquele cliente). */
export async function inviteClientUser(sql: Sql, agencyId: string, clientId: string, actorId: string, raw: unknown, now?: () => Date) {
  const { email } = z.object({ email: z.email().trim().toLowerCase().max(254) }).parse(raw);
  const client = await one(sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [clientId, agencyId]);
  if (!client) throw new XodoError("Cliente não encontrado.", 404);
  return insertInvite(sql, { agencyId, kind: "cliente", clientId, email, role: "cliente", actor: actorId, now });
}

export async function listInvites(sql: Sql, agencyId: string, now?: () => Date) {
  return sql.query(
    `select i.id, i.kind, i.client_id, c.name as client_name, i.email, i.role, i.created_at::text, i.expires_at::text,
            i.expires_at <= $2::timestamptz as expired
       from invites i left join clients c on c.id = i.client_id
      where i.agency_id = $1 and i.accepted_at is null and i.revoked_at is null
      order by i.created_at desc limit 200`,
    [agencyId, nowOf(now).toISOString()],
  );
}

export async function revokeInvite(sql: Sql, agencyId: string, actorId: string, inviteId: string, now?: () => Date) {
  const row = await one(
    sql,
    `update invites set revoked_at = $3::timestamptz where id = $1 and agency_id = $2 and accepted_at is null and revoked_at is null returning id`,
    [inviteId, agencyId, nowOf(now).toISOString()],
  );
  if (!row) throw new XodoError("Convite não encontrado ou já usado.", 404);
  await audit(sql, { agencyId, actor: actorId, action: "convite_cancelado", targetType: "invite", targetId: inviteId });
}

type InviteRow = {
  id: string;
  agency_id: string;
  agency_name: string;
  kind: "equipe" | "cliente";
  client_id: string | null;
  client_name: string | null;
  email: string;
  role: string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
};

async function findInvite(sql: Sql, token: string): Promise<InviteRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return one<InviteRow>(
    sql,
    `select i.id, i.agency_id, a.name as agency_name, i.kind, i.client_id, c.name as client_name, i.email, i.role,
            i.expires_at, i.accepted_at, i.revoked_at
       from invites i join agencies a on a.id = i.agency_id left join clients c on c.id = i.client_id
      where i.token_hash = $1`,
    [hashToken(token)],
  );
}

/** E-mail com o meio escondido (a prévia do convite é pública). */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  const shown = user.length <= 2 ? user[0] ?? "" : `${user.slice(0, 2)}`;
  return `${shown}***@${domain}`;
}

/** Prévia pública do convite (sem login): para o site mostrar "Você foi convidado para…". */
export async function previewInvite(sql: Sql, token: string, now?: () => Date) {
  const invite = await findInvite(sql, token);
  const valid = !!invite && !invite.accepted_at && !invite.revoked_at && new Date(invite.expires_at).getTime() > nowOf(now).getTime();
  if (!invite || !valid) throw new XodoError("Convite inválido, vencido ou já usado.", 404);
  return {
    agency_name: invite.agency_name,
    kind: invite.kind,
    client_name: invite.client_name,
    role: invite.role,
    email_hint: maskEmail(invite.email),
    expires_at: new Date(invite.expires_at).toISOString(),
  };
}

/** Aceita o convite com a conta logada (que precisa ter o e-mail convidado). */
export async function acceptInvite(sql: Sql, user: { id: string; email: string | null }, token: string, now?: () => Date) {
  return sql.transaction(async (tx) => {
    const invite = await findInvite(tx, token);
    const at = nowOf(now);
    if (!invite || invite.accepted_at || invite.revoked_at || new Date(invite.expires_at).getTime() <= at.getTime()) {
      throw new XodoError("Convite inválido, vencido ou já usado.", 404);
    }
    if (!user.email || user.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new XodoError(`Este convite é para ${maskEmail(invite.email)}. Entre com esse e-mail para aceitar.`, 403);
    }
    const claimed = await one(
      tx,
      `update invites set accepted_at = $2::timestamptz, accepted_by = $3 where id = $1 and accepted_at is null and revoked_at is null returning id`,
      [invite.id, at.toISOString(), user.id],
    );
    if (!claimed) throw new XodoError("Convite inválido, vencido ou já usado.", 404);
    if (invite.kind === "equipe") {
      // Quem já está na equipe mantém o papel que tem.
      await tx.query(
        `insert into agency_members (agency_id, user_id, role, invited_by)
         select $1, $2, $3, invited_by from invites where id = $4
         on conflict (agency_id, user_id) do nothing`,
        [invite.agency_id, user.id, invite.role, invite.id],
      );
    } else {
      await tx.query(
        `insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3) on conflict do nothing`,
        [invite.client_id, invite.agency_id, user.id],
      );
    }
    await audit(tx, { agencyId: invite.agency_id, actor: user.id, action: "convite_aceito", targetType: invite.kind, targetId: invite.id });
    return { agency_id: invite.agency_id, kind: invite.kind, client_id: invite.client_id, role: invite.role };
  });
}

/** Tira o acesso de alguém ao portal de um cliente. */
export async function removeClientUser(sql: Sql, agencyId: string, clientId: string, actorId: string, userId: string) {
  const row = await one(
    sql,
    `delete from client_portal_users where agency_id = $1 and client_id = $2 and user_id = $3 returning user_id`,
    [agencyId, clientId, userId],
  );
  if (!row) throw new XodoError("Acesso não encontrado.", 404);
  await audit(sql, { agencyId, actor: actorId, action: "acesso_cliente_removido", targetType: "client", targetId: clientId });
}

export async function listClientUsers(sql: Sql, agencyId: string, clientId: string) {
  return sql.query(
    `select cu.user_id, cu.created_at::text, p.full_name, u.email
       from client_portal_users cu left join profiles p on p.id = cu.user_id left join auth.users u on u.id = cu.user_id
      where cu.agency_id = $1 and cu.client_id = $2 order by cu.created_at`,
    [agencyId, clientId],
  );
}
