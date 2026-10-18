import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { createXodo, TEMPLATES } from "@/lib/xodos";

/** GET /api/xodos?agency_id=…  lista os xodós da agência (e os modelos prontos). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    const xodos = await sql.query(
      `select id, name, species, color, personality, role, provider, model, credential_id, daily_budget_usd::float8,
              warn_at_percent, timezone, status, client_scope, created_at::text
         from xodos where agency_id = $1 order by created_at`,
      [agencyId],
    );
    return NextResponse.json({ xodos, templates: TEMPLATES });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/xodos  { agency_id, name, species, personality, role, provider, model, credential_id, … } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    const xodo = await createXodo(sql, agencyId, body, userId);
    return NextResponse.json({ xodo }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
