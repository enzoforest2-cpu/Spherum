import { NextResponse } from "next/server";
import { setBillingInfo } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/agencies/:id/billing  { document, billing_email? }  dados de cobrança da assinatura do Spherum. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { allowLocked: true });
    await setBillingInfo(sql, agencyId, userId, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
