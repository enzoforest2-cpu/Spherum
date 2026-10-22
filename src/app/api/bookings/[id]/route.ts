import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelBooking } from "@/lib/core/bookings";
import { bookingDeps } from "@/lib/core/bookings-google";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/bookings/:id  { reason? }  cancela a reunião; o convidado recebe um e-mail e o evento sai da agenda. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(await request.json().catch(() => ({})));
    const sql = await serverSql();
    const row = await one<{ agency_id: string }>(sql, `select agency_id from bookings where id = $1`, [id]);
    if (!row) throw new XodoError("Reunião não encontrada.", 404);
    await requireRole(sql, userId, row.agency_id, CAN_USE);
    await cancelBooking(await bookingDeps(sql), row.agency_id, id, reason);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
