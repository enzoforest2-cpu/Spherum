import { NextResponse } from "next/server";
import { billingDepsFromEnv, updateInvoice } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

/** PATCH /api/billing/invoices/:id  { agency_id, action: cancelar | marcar_pago | reenviar | atualizar, paid_at? } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { area: "financeiro" });
    return NextResponse.json(await updateInvoice(billingDepsFromEnv(sql, masterKeyFromEnv()), agencyId, userId, id, input));
  } catch (error) {
    return fail(error);
  }
}
