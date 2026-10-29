import { NextResponse } from "next/server";
import { removeMember, updateMember } from "@/lib/core/team";
import { memberAccess } from "@/lib/core/roles";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string; userId: string }> };

/** PATCH /api/agencies/:id/members/:userId  { role?, title? }  (as regras de quem pode o quê ficam em team.ts) */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const actorId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, actorId, agencyId, CAN_READ);
    await updateMember(sql, agencyId, { id: actorId, access: (await memberAccess(sql, agencyId, actorId))! }, uuid.parse(p.userId), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/agencies/:id/members/:userId  tira da equipe (ou a própria pessoa sai). */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const actorId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, actorId, agencyId, CAN_READ);
    await removeMember(sql, agencyId, { id: actorId, access: (await memberAccess(sql, agencyId, actorId))! }, uuid.parse(p.userId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
