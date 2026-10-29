import { NextResponse } from "next/server";
import { setScoring } from "@/lib/core/scoring";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/agencies/:id/lead-scoring  { hot, warm, rules: [{ k, l, p, on, kind, value? }] }  critérios e faixas da pontuação. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "comercial" });
    return NextResponse.json({ scoring: await setScoring(sql, agencyId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}
