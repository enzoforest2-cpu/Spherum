import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { setAddon, subDepsFromEnv } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PUT /api/subscription/addons  { agency_id, addon, qty }  liga, desliga ou muda a quantidade (0 tira). */
export async function PUT(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { allowLocked: true, anyArea: ["financeiro", "configuracoes"] });
    return NextResponse.json(await setAddon(subDepsFromEnv(sql, mailerFromEnv()), agencyId, userId, input));
  } catch (error) {
    return fail(error);
  }
}
