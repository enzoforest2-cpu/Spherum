import { NextResponse } from "next/server";
import { removeEntry } from "@/lib/core/dre";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/finance/entries/:id[?from=AAAA-MM]  apaga; recorrente com from só para de repetir a partir daquele mês. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const row = await one<{ agency_id: string }>(sql, `select agency_id from finance_entries where id = $1`, [id]);
    if (!row) throw new XodoError("Lançamento não encontrado.", 404);
    await requireRole(sql, userId, row.agency_id, CAN_BILL);
    await removeEntry(sql, row.agency_id, id, new URL(request.url).searchParams.get("from") ?? undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
