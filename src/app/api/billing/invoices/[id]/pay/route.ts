import { NextResponse } from "next/server";
import { billingDepsFromEnv, payInvoice } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

/** POST /api/billing/invoices/:id/pay  { url, pix_code, boleto_line, boleto_url } para o cliente pagar agora. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    return NextResponse.json(await payInvoice(billingDepsFromEnv(sql, masterKeyFromEnv()), userId, id));
  } catch (error) {
    return fail(error);
  }
}
