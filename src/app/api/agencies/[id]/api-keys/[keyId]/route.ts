import { NextResponse } from "next/server";
import { revokeApiKey } from "@/lib/core/public-api";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string; keyId: string }> };

/** DELETE /api/agencies/:id/api-keys/:keyId  revoga a chave na hora (vale mesmo com a agência bloqueada pela cobrança). */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes", allowLocked: true });
    return NextResponse.json(await revokeApiKey(sql, agencyId, userId, uuid.parse(p.keyId)));
  } catch (error) {
    return fail(error);
  }
}
