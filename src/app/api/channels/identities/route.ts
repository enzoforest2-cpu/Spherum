import { NextResponse } from "next/server";
import { listIdentities } from "@/lib/channels/manage";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/channels/identities?agency_id=…  contas de canal vinculadas (as suas; owner e admin veem todas). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    const role = await requireRole(sql, userId, agencyId, CAN_USE, { area: "configuracoes" });
    return NextResponse.json({ identities: await listIdentities(sql, agencyId, userId, role) });
  } catch (error) {
    return fail(error);
  }
}
