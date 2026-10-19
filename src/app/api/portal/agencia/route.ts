import { NextResponse } from "next/server";
import { agencyPortal } from "@/lib/core/portal";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/portal/agencia?agency_id=…  tudo o que o portal da agência mostra ao abrir (núcleo). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await agencyPortal(sql, agencyId, userId));
  } catch (error) {
    return fail(error);
  }
}
