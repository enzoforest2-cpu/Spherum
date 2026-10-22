import { NextResponse } from "next/server";
import { setSla } from "@/lib/core/tickets";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/agencies/:id/ticket-sla  { alta, media, baixa }  horas para a primeira resposta em cada prioridade. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json({ sla: await setSla(sql, agencyId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}
