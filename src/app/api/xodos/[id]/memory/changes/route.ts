import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { listMemoryChanges } from "@/lib/xodos/memory/team";
import { loadXodo } from "@/lib/xodos/runner";

/** GET /api/xodos/:id/memory/changes?n=&run=&before_id=&limit=  diário da memória, do mais novo para o mais antigo. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_READ, { area: "xodos" });
    return NextResponse.json(await listMemoryChanges(sql, xodo, Object.fromEntries(new URL(request.url).searchParams)));
  } catch (error) {
    return fail(error);
  }
}
