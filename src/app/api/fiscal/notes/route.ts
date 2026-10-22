import { NextResponse } from "next/server";
import { z } from "zod";
import { emitForInvoice } from "@/lib/core/fiscal";
import { fiscalDeps } from "@/lib/core/fiscal-focus";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/fiscal/notes  { agency_id, invoice_ids }  emite as notas dessas faturas. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const p = z.object({ agency_id: uuid, invoice_ids: z.array(uuid).min(1).max(50) }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, p.agency_id, CAN_BILL);
    const deps = await fiscalDeps(sql);
    const results = [];
    for (const id of p.invoice_ids) {
      try { results.push({ invoice_id: id, ...(await emitForInvoice(deps, p.agency_id, id, userId)) }); }
      catch (error) { results.push({ invoice_id: id, status: "erro", error: error instanceof Error ? error.message : String(error) }); }
    }
    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
