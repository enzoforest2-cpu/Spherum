import { NextResponse } from "next/server";
import { z } from "zod";
import { setConfig } from "@/lib/core/fiscal";
import { connectFocus } from "@/lib/core/fiscal-focus";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/fiscal/connect  { agency_id, token, environment }  guarda o token da Focus NFe (conferido) e liga às notas. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const p = z.object({ agency_id: uuid, token: z.string(), environment: z.enum(["homologacao", "producao"]) }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, p.agency_id, CAN_BILL);
    const id = await connectFocus({ sql, ...serverIntegrations() }, p.agency_id, userId, p.token, p.environment);
    await setConfig(sql, p.agency_id, { connection_id: id, environment: p.environment });
    return NextResponse.json({ connection_id: id }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
