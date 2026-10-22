import { NextResponse } from "next/server";
import { metaPages } from "@/lib/core/content-meta";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/content/social?agency_id=&connection_id=  páginas do Facebook (e Instagram de cada uma) que a conexão da Meta administra. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const q = new URL(request.url).searchParams;
    const agencyId = uuid.parse(q.get("agency_id"));
    const connectionId = uuid.parse(q.get("connection_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ pages: await metaPages({ sql, ...serverIntegrations() }, agencyId, connectionId) });
  } catch (error) {
    return fail(error);
  }
}
