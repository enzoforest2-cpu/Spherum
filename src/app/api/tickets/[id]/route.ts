import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { ticketAgency } from "@/lib/core/http";
import { updateTicket } from "@/lib/core/tickets";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/tickets/:id  { priority?, assignee_user?, status: aberto | resolvido } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await ticketAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
    await updateTicket({ sql, mail: mailerFromEnv(), appUrl: process.env.APP_URL }, agencyId, id, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
