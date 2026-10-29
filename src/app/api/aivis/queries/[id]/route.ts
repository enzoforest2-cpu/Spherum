import { NextResponse } from "next/server";
import { deleteQuery } from "@/lib/core/aivis";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/aivis/queries/:id  tira a pergunta (e as checagens dela). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const row = await one<{ agency_id: string }>(sql, `select agency_id from aivis_queries where id = $1`, [id]);
    if (!row) throw new XodoError("Pergunta não encontrada.", 404);
    await requireRole(sql, userId, row.agency_id, CAN_USE, { area: "campanhas" });
    await deleteQuery(sql, row.agency_id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
