import { NextResponse } from "next/server";
import { deleteType, typeSlots, updateType } from "@/lib/core/bookings";
import { bookingDeps } from "@/lib/core/bookings-google";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"], roles: typeof CAN_USE) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const row = await one<{ agency_id: string }>(sql, `select agency_id from booking_types where id = $1`, [id]);
  if (!row) throw new XodoError("Tipo de reunião não encontrado.", 404);
  await requireRole(sql, userId, row.agency_id, roles);
  return { id, agencyId: row.agency_id, sql };
}

/** GET /api/bookings/types/:id  horários livres (o mesmo que a página pública mostra). */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params, CAN_READ);
    return NextResponse.json({ days: await typeSlots(await bookingDeps(sql), agencyId, id) });
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/bookings/types/:id  os mesmos campos da criação. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params, CAN_USE);
    await updateType(sql, agencyId, id, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/bookings/types/:id  (sem reuniões futuras marcadas). */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params, CAN_USE);
    await deleteType(sql, agencyId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
