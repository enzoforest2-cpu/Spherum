import { NextResponse } from "next/server";
import { z } from "zod";
import { setCostPerHour } from "@/lib/core/profit";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/agencies/:id/cost-per-hour  { value }  custo de uma hora da equipe (rentabilidade). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const { value } = z.object({ value: z.number() }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { area: "financeiro" });
    await setCostPerHour(sql, agencyId, value);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
