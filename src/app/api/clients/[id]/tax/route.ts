import { NextResponse } from "next/server";
import { setClientTax } from "@/lib/core/fiscal";
import { clientAgency } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/clients/:id/tax  { cnpj?, legal_name?, billing_email? }  dados do tomador da nota. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_BILL);
    await setClientTax(sql, agencyId, clientId, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
