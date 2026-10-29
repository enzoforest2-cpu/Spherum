import { NextResponse } from "next/server";
import { createDeal, crmBoard } from "@/lib/core/crm";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/deals?agency_id=  negócios do funil e os números (previsão, taxa de fechamento, ciclo). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "comercial" });
    return NextResponse.json(await crmBoard(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/deals  { agency_id, company, contact_name?, email?, phone?, segment?, website?, source?, value?, stage?, owner_user?, next_action?, next_action_date?, notes? } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
    return NextResponse.json({ deal: await createDeal(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
