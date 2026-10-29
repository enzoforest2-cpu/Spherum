import { NextResponse } from "next/server";
import { quote } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/subscription/quote  { agency_id, plan, cycle?, coupon? }  quanto fica, com o cupom conferido. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "configuracoes" });
    return NextResponse.json(await quote(sql, agencyId, input));
  } catch (error) {
    return fail(error);
  }
}
