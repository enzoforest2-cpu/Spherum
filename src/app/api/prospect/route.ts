import { NextResponse } from "next/server";
import { prospectBoard, setConfig } from "@/lib/core/prospect";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/prospect?agency_id=  configuração, leads, números da cadência e das variações. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "comercial" });
    return NextResponse.json(await prospectBoard(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/prospect  { agency_id, connection_id?, daily_limit?, running?, lang?, steps?, variations? }  (dono ou admin). */
export async function PATCH(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "comercial" });
    return NextResponse.json({ config: await setConfig(sql, agencyId, input) });
  } catch (error) {
    return fail(error);
  }
}
