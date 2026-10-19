import { NextResponse } from "next/server";
import { billingDepsFromEnv, disconnectAccount, setDefaultAccount } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/billing/accounts/:id  { agency_id, is_default: true }  passa a cobrar por esta conta. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const agencyId = uuid.parse((await request.json())?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    await setDefaultAccount(sql, agencyId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/billing/accounts/:id?agency_id=…  desconecta (as faturas já criadas continuam no provedor). */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    await disconnectAccount(billingDepsFromEnv(sql, masterKeyFromEnv()), agencyId, userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
