import { NextResponse } from "next/server";
import { appBoard, setPrefs } from "@/lib/core/push";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/app?agency_id=  as suas preferências de notificação, os seus aparelhos e a chave pública VAPID. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await appBoard(sql, agencyId, userId));
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/app  { agency_id, categories?, quiet_start?, quiet_end? }  as suas preferências. */
export async function PATCH(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ prefs: await setPrefs(sql, agencyId, userId, input) });
  } catch (error) {
    return fail(error);
  }
}
