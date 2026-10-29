import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { createXodo } from "@/lib/xodos";
import { serverLlm } from "@/lib/xodos/llm";

/** GET /api/xodos?agency_id=…  lista os xodós da agência. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "xodos" });
    const xodos = await sql.query(
      `select x.id, x.name, x.species, x.color, x.personality, x.role, x.autonomy, x.provider, x.model, x.credential_id,
              x.routine_provider, x.routine_model, x.routine_credential_id,
              x.daily_budget_brl::float8, x.warn_at_percent, x.timezone, x.status, x.client_scope, x.created_at::text,
              coalesce((select json_agg(json_build_object('provider', m.provider, 'model', m.model, 'credential_id', m.credential_id)
                                        order by m.position)
                          from xodo_models m where m.xodo_id = x.id), '[]') as backup_models
         from xodos x where x.agency_id = $1 order by x.created_at`,
      [agencyId],
    );
    return NextResponse.json({ xodos });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/xodos  { agency_id, name, species, color, personality, autonomy, provider, model, credential_id, backup_models, daily_budget_brl, … } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "xodos" });
    const xodo = await createXodo(sql, serverLlm(), agencyId, body, userId);
    return NextResponse.json({ xodo }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
