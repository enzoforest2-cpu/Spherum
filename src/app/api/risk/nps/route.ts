import { NextResponse } from "next/server";
import { requestNps } from "@/lib/core/risk";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/risk/nps  { agency_id, client_ids, question }  pede o NPS; o portal de cada cliente mostra a pergunta. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "clientes" });
    return NextResponse.json(await requestNps(sql, agencyId, userId, input));
  } catch (error) {
    return fail(error);
  }
}
