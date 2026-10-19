import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { revertNotes } from "@/lib/xodos/memory/team";
import { loadXodo } from "@/lib/xodos/runner";

/** POST /api/xodos/:id/memory/changes/:batch/revert  desfaz o lote inteiro (409 se alguma nota mudou depois). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; batch: string }> }) {
  try {
    const userId = await requireUser(request);
    const { id, batch } = await params;
    const xodoId = uuid.parse(id);
    const batchId = uuid.parse(batch);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    const role = await requireRole(sql, userId, xodo.agency_id, CAN_USE);
    return NextResponse.json(await revertNotes(sql, xodo, batchId, { userId, manage: CAN_MANAGE.includes(role) }));
  } catch (error) {
    return fail(error);
  }
}
