import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { listSupport, openSupport } from "@/lib/core/support";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/support?agency_id=  chamados da agência com o suporte do Spherum. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ tickets: await listSupport(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/support  { agency_id, subject, text, priority? } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ ticket: await openSupport(sql, mailerFromEnv(), agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
