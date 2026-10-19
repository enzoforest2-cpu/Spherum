import { NextResponse } from "next/server";
import { billingDepsFromEnv, createInvoice, listInvoices } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

/** GET /api/billing/invoices?agency_id=…[&client_id=…] */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const search = new URL(request.url).searchParams;
    const agencyId = uuid.parse(search.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ invoices: await listInvoices(sql, agencyId, search.get("client_id") ? uuid.parse(search.get("client_id")) : null) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/billing/invoices  { agency_id, client_id, description, amount, due_date, methods, notes?, monthly? }  cria e cobra no provedor. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    return NextResponse.json(await createInvoice(billingDepsFromEnv(sql, masterKeyFromEnv()), agencyId, userId, input), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
