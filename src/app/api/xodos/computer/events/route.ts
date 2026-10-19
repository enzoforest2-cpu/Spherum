import { NextResponse } from "next/server";
import { listEvents } from "@/lib/computer/manage";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/xodos/computer/events?agency_id=…&before=…&limit=…  linha do tempo (mais novos primeiro). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const search = new URL(request.url).searchParams;
    const agencyId = uuid.parse(search.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(
      await listEvents(sql, agencyId, { before: search.get("before") ?? undefined, limit: search.get("limit") ?? undefined }),
    );
  } catch (error) {
    return fail(error);
  }
}
