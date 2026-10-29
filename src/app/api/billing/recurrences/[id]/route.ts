import { NextResponse } from "next/server";
import { z } from "zod";
import { setRecurrenceActive } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/billing/recurrences/:id  { agency_id, active }  pausa ou volta a gerar a mensalidade. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const body = z.object({ agency_id: uuid, active: z.boolean() }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, body.agency_id, CAN_BILL, { area: "financeiro" });
    await setRecurrenceActive(sql, body.agency_id, id, body.active);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
