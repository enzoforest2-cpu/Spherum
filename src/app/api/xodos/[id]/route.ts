import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { updateXodo } from "@/lib/xodos";
import { audit } from "@/lib/core/audit";
import { deleteXodo } from "@/lib/xodos/manage";
import { serverLlm } from "@/lib/xodos/llm";
import { loadXodo } from "@/lib/xodos/runner";

/** PATCH /api/xodos/:id  muda o que foi escolhido na criação (nome, forma, cor, jeito, autonomia, teto, cérebro e reservas) ou pausa. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE, { area: "xodos" });
    return NextResponse.json({ xodo: await updateXodo(sql, serverLlm(), xodo.agency_id, xodoId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/xodos/:id?confirmar=<nome>  exclui de vez (dono e admin). Para só parar, use PATCH { status: "paused" }. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE, { area: "xodos" });
    const { name } = await deleteXodo(sql, xodo.agency_id, xodoId, new URL(request.url).searchParams.get("confirmar") ?? "");
    await audit(sql, { agencyId: xodo.agency_id, actor: userId, action: "xodo_excluido", targetType: "xodo", targetId: xodoId, summary: name });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
