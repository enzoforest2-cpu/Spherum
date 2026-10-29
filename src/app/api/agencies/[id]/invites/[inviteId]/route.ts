import { NextResponse } from "next/server";
import { revokeInvite } from "@/lib/core/team";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/agencies/:id/invites/:inviteId  cancela o convite. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; inviteId: string }> }) {
  try {
    const userId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "equipe" });
    await revokeInvite(sql, agencyId, userId, uuid.parse(p.inviteId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
