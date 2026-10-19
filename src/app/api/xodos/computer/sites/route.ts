import { NextResponse } from "next/server";
import { listSiteRules, setSiteRules } from "@/lib/computer/manage";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET ?agency_id=…  regras de categoria por site da agência. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ rules: await listSiteRules(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** PUT { agency_id, rules: [{ pattern, category }] }  troca todas as regras. */
export async function PUT(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id ?? new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json({ rules: await setSiteRules(sql, agencyId, userId, { rules: body?.rules }) });
  } catch (error) {
    return fail(error);
  }
}
