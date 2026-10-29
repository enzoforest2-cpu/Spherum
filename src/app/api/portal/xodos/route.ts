import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { xodoScreen } from "@/lib/xodos/screen";

/** GET /api/portal/xodos?agency_id=…  a aba Xodós do portal da agência: equipe, gasto, aprovações, regras e chaves. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "xodos" });
    return NextResponse.json(await xodoScreen(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}
