import { NextResponse } from "next/server";
import { setPortalSettings } from "@/lib/core/collab";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/agencies/:id/portal-settings  { auto_publicar }  o que os xodós fazem aparece no portal sem passar pela equipe. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json({ portal_settings: await setPortalSettings(sql, agencyId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}
