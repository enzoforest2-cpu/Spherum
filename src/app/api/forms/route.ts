import { NextResponse } from "next/server";
import { createForm, listForms } from "@/lib/core/forms";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/forms?agency_id=  formulários com as respostas dos últimos 90 dias. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ forms: await listForms(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/forms  { agency_id, name, fields?, cta?, thanks?, deal_stage?, owner_user?, notify?, active? } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ form: await createForm(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
