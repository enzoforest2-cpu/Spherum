import { NextResponse } from "next/server";
import { deleteWebhook } from "@/lib/core/webhooks";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string; hookId: string }> };

/** DELETE /api/agencies/:id/webhooks/:hookId  apaga o endereço e as entregas pendentes dele. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes", allowLocked: true });
    return NextResponse.json(await deleteWebhook(sql, agencyId, userId, uuid.parse(p.hookId)));
  } catch (error) {
    return fail(error);
  }
}
