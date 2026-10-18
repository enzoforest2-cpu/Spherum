import { NextResponse } from "next/server";
import { serverIntegrations } from "@/lib/integrations";
import { revokeConnection } from "@/lib/integrations/store";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/integrations/connections/:id?agency_id=…  desconecta (revoga na plataforma quando dá e apaga os tokens). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const connectionId = uuid.parse((await params).id);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    await revokeConnection({ sql, ...serverIntegrations() }, agencyId, connectionId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
