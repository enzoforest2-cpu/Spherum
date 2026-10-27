import { NextResponse } from "next/server";
import { listNotifications, markNotificationsRead } from "@/lib/core/notifications";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/notifications?agency_id=  as últimas notificações da agência e da pessoa. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ notifications: await listNotifications(sql, agencyId, userId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/notifications  { agency_id, ids? }  marca como lidas (sem ids, todas). */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await markNotificationsRead(sql, agencyId, userId, input));
  } catch (error) {
    return fail(error);
  }
}
