import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { updateXodo } from "@/lib/xodos";
import { loadXodo } from "@/lib/xodos/runner";

/** PATCH /api/xodos/:id  { status?, daily_budget_usd?, warn_at_percent?, instructions?, model?, credential_id? } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE);
    return NextResponse.json({ xodo: await updateXodo(sql, xodo.agency_id, xodoId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}
