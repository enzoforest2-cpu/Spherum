import { NextResponse } from "next/server";
import { createProposal, listProposals } from "@/lib/core/proposals";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/proposals?agency_id=  propostas, o catálogo da agência e os números. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await listProposals(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/proposals  { agency_id, company, contact_name?, email?, phone?, source?, deal_id?, client_id?, doc, monthly_cents, one_time_cents, term_months } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ proposal: await createProposal(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
