import { NextResponse } from "next/server";
import { deleteDeal, updateDeal } from "@/lib/core/crm";
import { dealAgency } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const agencyId = await dealAgency(sql, id);
  await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
  return { userId, id, agencyId, sql };
}

/** PATCH /api/deals/:id  campos do negócio, stage (até perdido; ganho é pelo /win), lost_reason, contacted: true (contato feito agora). */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    await updateDeal(sql, agencyId, userId, id, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    await deleteDeal(sql, agencyId, userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
