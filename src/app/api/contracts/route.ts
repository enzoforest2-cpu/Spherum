import { NextResponse } from "next/server";
import { createContract, listContracts } from "@/lib/core/contracts";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/contracts?agency_id=  contratos com a situação de hoje. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "financeiro" });
    return NextResponse.json({ contracts: await listContracts(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/contracts  { agency_id, client_id, monthly_fee, start_date, end_date, billing: nova | existente | nenhuma, billing_day?, document_id?, notes? } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { area: "financeiro" });
    return NextResponse.json({ contract: await createContract(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
