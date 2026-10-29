import { NextResponse } from "next/server";
import { createType } from "@/lib/core/bookings";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/**
 * POST /api/bookings/types  { agency_id, name, description?, duration_min?, color?, days?, from_hour?, to_hour?,
 *   min_notice_hours?, max_days_ahead?, connection_id?, calendar_id?, owner_user?, create_deal?, active? }
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
    return NextResponse.json({ type: await createType(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
