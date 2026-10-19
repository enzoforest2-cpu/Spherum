import { NextResponse } from "next/server";
import { createReport } from "@/lib/core/reports";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/reports  { agency_id, client_id, title, period_start, period_end, body_md, publish }  publicado aparece no portal do cliente. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ report: await createReport(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
