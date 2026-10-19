import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { IntegrationError } from "../integrations/http";
import { one, type Sql } from "./db";
import { XodoError } from "./runner";

/**
 * Autenticação das rotas dos Xodós: o navegador manda o token do Supabase Auth em
 * "Authorization: Bearer"; o servidor confirma o usuário no Supabase e o papel dele na
 * agência pelo banco. Papéis seguem a base do backend (owner, admin, member, viewer).
 */

export type Role = "owner" | "admin" | "member" | "viewer" | "financeiro";
export const CAN_MANAGE: Role[] = ["owner", "admin"];
export const CAN_USE: Role[] = ["owner", "admin", "member"];
export const CAN_READ: Role[] = ["owner", "admin", "member", "viewer", "financeiro"];
/** Cobra os clientes e conecta o meio de pagamento. */
export const CAN_BILL: Role[] = ["owner", "admin", "financeiro"];

export async function requireUser(request: Request): Promise<string> {
  return (await requireAuth(request)).id;
}

export type AuthUser = { id: string; email: string | null; meta: Record<string, unknown> };

/** Usuário do token, com e-mail e os dados guardados no cadastro (user_metadata). */
export async function requireAuth(request: Request): Promise<AuthUser> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new XodoError("Faça login para continuar.", 401);
  const { supabase } = await import("@/lib/supabase");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new XodoError("Sessão inválida ou expirada.", 401);
  return { id: data.user.id, email: data.user.email?.toLowerCase() ?? null, meta: data.user.user_metadata ?? {} };
}

export async function requireRole(sql: Sql, userId: string, agencyId: string, allowed: Role[]): Promise<Role> {
  const member = await one<{ role: Role }>(
    sql,
    `select role from agency_members where agency_id = $1 and user_id = $2`,
    [agencyId, userId],
  );
  // Mesmo erro para "não existe" e "não é sua", para não revelar outras agências.
  if (!member) throw new XodoError("Não encontrado", 404);
  if (!allowed.includes(member.role)) throw new XodoError("Seu papel na agência não permite esta ação.", 403);
  return member.role;
}

export const uuid = z.uuid();

export function fail(error: unknown) {
  if (error instanceof XodoError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof IntegrationError) return NextResponse.json({ error: error.message, reconnect: error.reauth }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "Dados inválidos", issues: z.treeifyError(error) }, { status: 400 });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  console.error("[xodos]", error);
  return NextResponse.json({ error: "Erro interno" }, { status: 500 });
}
