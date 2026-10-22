import { NextResponse } from "next/server";
import { bookingBoard } from "@/lib/core/bookings";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/bookings?agency_id=  tipos de reunião e reuniões (dos últimos 30 dias em diante). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await bookingBoard(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}
