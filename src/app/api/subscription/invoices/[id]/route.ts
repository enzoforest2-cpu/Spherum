import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { payLink, subDepsFromEnv } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/subscription/invoices/:id  { agency_id }  link para pagar uma fatura em aberto. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await request.json()).agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { allowLocked: true, area: "configuracoes" });
    return NextResponse.json({ invoice: await payLink(subDepsFromEnv(sql, mailerFromEnv()), agencyId, uuid.parse((await params).id)) });
  } catch (error) {
    return fail(error);
  }
}
