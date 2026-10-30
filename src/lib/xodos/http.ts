import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { IntegrationError } from "../integrations/http";
import { one, type Sql } from "./db";
import { XodoError } from "./runner";
import { accessOf, AREAS, atLeast, type Area } from "../core/roles";

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

const LOCKED: Record<string, string> = {
  teste: "O teste grátis acabou. Escolha um plano em Configurações → Plano e cobrança para continuar criando e editando.",
  atraso: "A fatura do Spherum está em atraso. Pague em Configurações → Plano e cobrança para liberar a agência.",
  cancelada: "A assinatura terminou. Escolha um plano em Configurações → Plano e cobrança para continuar.",
};

/**
 * Papel de quem pede na agência. Agência bloqueada pela cobrança (teste acabou, atraso, cancelada):
 * ler continua (CAN_READ) e o que tem allowLocked (assinatura, suporte) também; o resto é recusado.
 *
 * Com area, vale o cargo da pessoa (ver core/roles.ts): ler pede "ver" na área e o resto pede
 * "editar". area pode ser uma lista (precisa de todas); anyArea é uma lista em que basta uma.
 * Sem área, ler (CAN_READ) passa; usar (CAN_USE) pede "editar" em alguma área (cargo só de
 * leitura não age); gerir (CAN_MANAGE) pede editar nas configurações e cobrar (CAN_BILL) pede
 * editar no financeiro. O dono pode tudo.
 * Devolve o papel antigo equivalente (algumas regras internas ainda usam).
 */
export async function requireRole(sql: Sql, userId: string, agencyId: string, allowed: Role[], opts: { allowLocked?: boolean; area?: Area | Area[]; anyArea?: Area[] } = {}): Promise<Role> {
  const member = await one<{ role: Role; perms: unknown | null; role_id: string | null; role_name: string | null; suspended: boolean; locked: string | null }>(
    sql,
    `select m.role, r.perms, m.role_id, r.name as role_name, a.suspended_at is not null as suspended,
            case when a.locked_at is not null then coalesce(a.locked_reason, 'teste') end as locked
       from agency_members m join agencies a on a.id = m.agency_id left join agency_roles r on r.id = m.role_id and r.agency_id = m.agency_id
      where m.agency_id = $1 and m.user_id = $2`,
    [agencyId, userId],
  );
  // Mesmo erro para "não existe" e "não é sua", para não revelar outras agências.
  if (!member) throw new XodoError("Não encontrado", 404);
  // Suspensa pela equipe do Spherum: ninguém da agência age até a reativação (os dados ficam guardados).
  if (member.suspended) throw new XodoError("Esta agência está suspensa. Fale com o suporte do Spherum (suporte@spherum.com.br).", 403);
  const access = accessOf(member);
  if (!access.owner) {
    const reading = allowed === CAN_READ, need = reading ? "ver" : "editar";
    const fallback: Area | null = allowed === CAN_MANAGE ? "configuracoes" : allowed === CAN_BILL ? "financeiro" : null;
    const all: Area[] = opts.area ? ([] as Area[]).concat(opts.area) : opts.anyArea ? [] : fallback ? [fallback] : [];
    const labelOf = (a: Area) => AREAS.find((x) => x.key === a)?.label ?? a;
    for (const area of all) {
      if (!atLeast(access.perms[area], need)) {
        throw new XodoError(reading ? `Seu cargo não tem acesso a ${labelOf(area)}.` : `Seu cargo só permite ver ${labelOf(area)}, não alterar.`, 403);
      }
    }
    if (opts.anyArea && !opts.anyArea.some((a) => atLeast(access.perms[a], need))) {
      throw new XodoError(`Seu cargo precisa ${reading ? "ver" : "editar"} ${opts.anyArea.map(labelOf).join(" ou ")}.`, 403);
    }
    if (!all.length && !opts.anyArea && !reading && !Object.values(access.perms).includes("editar")) {
      throw new XodoError("Seu cargo só permite ver, não alterar.", 403);
    }
    // Lista própria de papéis (ex.: só o dono), sem área: vale o papel.
    if (!all.length && !opts.anyArea && ![CAN_READ, CAN_USE, CAN_MANAGE, CAN_BILL].includes(allowed) && !allowed.includes(member.role)) {
      throw new XodoError("Seu cargo na agência não permite esta ação.", 403);
    }
  }
  if (member.locked && allowed !== CAN_READ && !opts.allowLocked) throw new XodoError(LOCKED[member.locked] ?? LOCKED.teste, 402);
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
