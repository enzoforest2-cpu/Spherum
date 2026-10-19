import { NextResponse } from "next/server";
import { createAgency, updateProfile } from "@/lib/core/agencies";
import { one, serverSql } from "@/lib/xodos/db";
import { fail, requireAuth } from "@/lib/xodos/http";

/**
 * POST /api/agencies  { name, website?, phone?, state?, plan?, onboarding? }  cria a agência com
 * quem chamou como dona. Sem corpo, usa o que a pessoa preencheu no cadastro (guardado no login).
 */
export async function POST(request: Request) {
  try {
    const user = await requireAuth(request);
    const text = await request.text();
    const body = text ? JSON.parse(text) : (user.meta.signup ?? {});
    const sql = await serverSql();
    // Sem corpo é a criação automática depois do cadastro: se a pessoa já é dona de uma agência
    // (clique duplo, aba aberta duas vezes), devolve a que existe.
    if (!text) {
      const existing = await one<{ id: string; name: string; slug: string }>(
        sql,
        `select a.id, a.name, a.slug from agency_members m join agencies a on a.id = m.agency_id
          where m.user_id = $1 and m.role = 'owner' order by m.created_at limit 1`,
        [user.id],
      );
      if (existing) return NextResponse.json({ agency: existing });
    }
    const agency = await createAgency(sql, user.id, body);
    // Nome e telefone do passo 1 do cadastro vão para o perfil.
    const fullName = typeof user.meta.full_name === "string" ? user.meta.full_name : undefined;
    const phone = typeof user.meta.phone === "string" ? user.meta.phone : undefined;
    if (fullName || phone) await updateProfile(sql, user.id, { full_name: fullName, phone }).catch(() => undefined);
    return NextResponse.json({ agency }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
