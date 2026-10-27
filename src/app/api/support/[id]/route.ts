import { NextResponse } from "next/server";
import { replySupportAgency } from "@/lib/core/support";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/support/:id  { agency_id, text }  responde (e reabre) um chamado do suporte. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { allowLocked: true });
    await replySupportAgency(sql, agencyId, userId, uuid.parse((await params).id), input);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
