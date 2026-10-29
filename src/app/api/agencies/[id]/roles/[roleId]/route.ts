import { NextResponse } from "next/server";
import { deleteRole, memberAccess, updateRole } from "@/lib/core/roles";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string; roleId: string }> };

/** PATCH /api/agencies/:id/roles/:roleId  { name?, description?, perms? } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "equipe" });
    const actor = { id: userId, ...(await memberAccess(sql, agencyId, userId))! };
    return NextResponse.json(await updateRole(sql, agencyId, actor, uuid.parse(p.roleId), await request.json()));
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/agencies/:id/roles/:roleId?mover_para=:outroCargo  (obrigatório se alguém usa o cargo) */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "equipe" });
    const actor = { id: userId, ...(await memberAccess(sql, agencyId, userId))! };
    const moveTo = new URL(request.url).searchParams.get("mover_para");
    return NextResponse.json(await deleteRole(sql, agencyId, actor, uuid.parse(p.roleId), moveTo ? uuid.parse(moveTo) : null));
  } catch (error) {
    return fail(error);
  }
}
