import { NextResponse } from "next/server";
import { createClient, listClients } from "@/lib/core/clients";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/clients?agency_id=…&archived=1  clientes da agência (com o contato principal). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const url = new URL(request.url);
    const agencyId = uuid.parse(url.searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "clientes" });
    return NextResponse.json({ clients: await listClients(sql, agencyId, { archived: url.searchParams.get("archived") === "1" }) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/clients  { agency_id, name, segment?, status?, monthly_fee?, started_on?, … } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "clientes" });
    const { agency_id: _drop, ...input } = body;
    void _drop;
    return NextResponse.json({ client: await createClient(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
