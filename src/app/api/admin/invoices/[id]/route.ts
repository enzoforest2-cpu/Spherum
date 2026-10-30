import { NextResponse } from "next/server";
import { staffCan } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { mailerFromEnv } from "@/lib/core/email";
import { adminInvoiceAction, subDepsFromEnv } from "@/lib/core/subscription";
import { fail, uuid } from "@/lib/xodos/http";

/** POST /api/admin/invoices/:id  { action: refund | cancel, reason }  estorna (pelo Asaas) ou cancela uma fatura do Spherum. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    staffCan(role, "billing");
    await adminInvoiceAction(subDepsFromEnv(sql, mailerFromEnv()), userId, uuid.parse((await params).id), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
