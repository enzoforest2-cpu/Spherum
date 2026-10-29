import { NextResponse } from "next/server";
import { openTicket, ticketBoard } from "@/lib/core/tickets";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/tickets?agency_id=  chamados abertos e dos últimos 30 dias, com os números. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "clientes" });
    return NextResponse.json(await ticketBoard(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/tickets  { agency_id, client_id, subject, priority?, text?, assignee_user? }  a equipe registra um pedido que chegou por fora. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "clientes" });
    return NextResponse.json({ ticket: await openTicket(sql, agencyId, userId, "agencia", input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
