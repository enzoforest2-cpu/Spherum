import { NextResponse } from "next/server";
import { fiscalBoard, setConfig } from "@/lib/core/fiscal";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/fiscal?agency_id=  configuração, notas, faturas sem nota, mensalidades, atrasos e conexões da Focus NFe. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    return NextResponse.json(await fiscalBoard(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/fiscal  { agency_id, ...configuração }  (quem cuida da cobrança). */
export async function PATCH(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    return NextResponse.json({ config: await setConfig(sql, agencyId, input) });
  } catch (error) {
    return fail(error);
  }
}
