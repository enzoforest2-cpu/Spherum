import { NextResponse } from "next/server";
import { unlinkIdentity } from "@/lib/channels/manage";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/channels/identities/:id?agency_id=…  desfaz o vínculo (a própria pessoa, ou owner e admin). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    const role = await requireRole(sql, userId, agencyId, CAN_USE);
    await unlinkIdentity(sql, agencyId, id, userId, role);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
