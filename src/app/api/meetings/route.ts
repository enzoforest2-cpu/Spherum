import { NextResponse } from "next/server";
import { createMeeting, listMeetings } from "@/lib/core/meetings";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/meetings?agency_id=  reuniões com a ata e os passos. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ meetings: await listMeetings(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/meetings  { agency_id, client_id, title, meeting_date, meeting_time?, attendees? }  registra a reunião (a ata vem depois). */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ meeting: await createMeeting(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
