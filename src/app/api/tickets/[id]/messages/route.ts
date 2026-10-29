import { NextResponse } from "next/server";
import { z } from "zod";
import { mailerFromEnv } from "@/lib/core/email";
import { ticketAgency } from "@/lib/core/http";
import { replyTicket } from "@/lib/core/tickets";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/tickets/:id/messages  { text }  a equipe responde; o cliente recebe no portal e por e-mail. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { text } = z.object({ text: z.string() }).parse(await request.json());
    const sql = await serverSql();
    const agencyId = await ticketAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "clientes" });
    await replyTicket({ sql, mail: mailerFromEnv(), appUrl: process.env.APP_URL }, agencyId, userId, "agencia", id, text);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
