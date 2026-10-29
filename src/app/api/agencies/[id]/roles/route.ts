import { NextResponse } from "next/server";
import { AREAS, createRole, listRoles, memberAccess } from "@/lib/core/roles";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agencies/:id/roles  cargos da agência, as áreas e o que você pode. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "equipe" });
    const me = (await memberAccess(sql, agencyId, userId))!;
    return NextResponse.json({ roles: await listRoles(sql, agencyId), areas: AREAS, me });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/agencies/:id/roles  { name, description?, perms: { area: "nenhum" | "ver" | "editar" } } */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "equipe" });
    const actor = { id: userId, ...(await memberAccess(sql, agencyId, userId))! };
    return NextResponse.json({ role: await createRole(sql, agencyId, actor, await request.json()) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
