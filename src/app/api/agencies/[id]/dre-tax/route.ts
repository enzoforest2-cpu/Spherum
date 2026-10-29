import { NextResponse } from "next/server";
import { z } from "zod";
import { setTax } from "@/lib/core/dre";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/agencies/:id/dre-tax  { pct }  alíquota de impostos sobre a receita no DRE. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const { pct } = z.object({ pct: z.number() }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { area: "financeiro" });
    await setTax(sql, agencyId, pct);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
