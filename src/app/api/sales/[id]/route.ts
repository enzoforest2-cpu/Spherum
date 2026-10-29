import { NextResponse } from "next/server";
import { deleteSale } from "@/lib/core/roi";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/sales/:id  apaga uma venda lançada. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const row = await one<{ agency_id: string }>(sql, `select agency_id from client_sales where id = $1`, [id]);
    if (!row) throw new XodoError("Venda não encontrada.", 404);
    await requireRole(sql, userId, row.agency_id, CAN_USE, { area: "comercial" });
    await deleteSale(sql, row.agency_id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
