import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelNote } from "@/lib/core/fiscal";
import { fiscalDeps } from "@/lib/core/fiscal-focus";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/fiscal/notes/:id  { reason }  cancela a nota na prefeitura (ou descarta a que deu erro). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { reason } = z.object({ reason: z.string().default("") }).parse(await request.json().catch(() => ({})));
    const sql = await serverSql();
    const row = await one<{ agency_id: string; status: string }>(sql, `select agency_id, status from fiscal_notes where id = $1`, [id]);
    if (!row) throw new XodoError("Nota não encontrada.", 404);
    await requireRole(sql, userId, row.agency_id, CAN_BILL);
    await cancelNote(await fiscalDeps(sql), row.agency_id, id, row.status === "emitida" ? reason : reason || "Nota descartada pela agência");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
