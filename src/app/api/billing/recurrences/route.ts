import { NextResponse } from "next/server";
import { listRecurrences } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/billing/recurrences?agency_id=…  mensalidades automáticas. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ recurrences: await listRecurrences(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}
