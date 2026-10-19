import type { Sql } from "../xodos/db";

/** Registro de ação sensível (papéis, convites, exclusões). Nunca recebe dados pessoais no resumo. */
export async function audit(
  sql: Sql,
  e: { agencyId: string | null; actor: string | null; action: string; targetType?: string; targetId?: string; summary?: string },
) {
  await sql.query(
    `insert into audit_events (agency_id, actor_user_id, action, target_type, target_id, summary) values ($1, $2, $3, $4, $5, $6)`,
    [e.agencyId, e.actor, e.action, e.targetType ?? null, e.targetId ?? null, e.summary?.slice(0, 300) ?? null],
  );
}
