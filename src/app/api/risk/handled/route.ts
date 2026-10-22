import { NextResponse } from "next/server";
import { z } from "zod";
import { markRiskHandled } from "@/lib/core/risk";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/risk/handled  { agency_id, client_id, note? }  registra a ação tomada (o risco baixa por 14 dias). */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const b = z.object({ agency_id: uuid, client_id: uuid, note: z.string().max(500).optional() }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, b.agency_id, CAN_USE);
    await markRiskHandled(sql, b.agency_id, userId, b.client_id, b.note);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
