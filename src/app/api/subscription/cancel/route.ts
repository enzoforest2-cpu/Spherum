import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { cancelSubscription, subDepsFromEnv } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/subscription/cancel  { agency_id, resume? }  cancela no fim do período (resume: true desfaz). */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { allowLocked: true, area: ["equipe", "configuracoes"] });
    return NextResponse.json(await cancelSubscription(subDepsFromEnv(sql, mailerFromEnv()), agencyId, userId, input));
  } catch (error) {
    return fail(error);
  }
}
