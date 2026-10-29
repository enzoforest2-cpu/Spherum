import { NextResponse } from "next/server";
import { deleteTime } from "@/lib/core/profit";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_MANAGE, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/time/:id  apaga um registro de horas (o próprio; dono e admin apagam qualquer um). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const row = await one<{ agency_id: string }>(sql, `select agency_id from time_entries where id = $1`, [id]);
    if (!row) throw new XodoError("Registro não encontrado.", 404);
    const role = await requireRole(sql, userId, row.agency_id, CAN_USE, { area: "projetos" });
    await deleteTime(sql, row.agency_id, userId, id, CAN_MANAGE.includes(role));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
