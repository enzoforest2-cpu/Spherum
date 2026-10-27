import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { subDepsFromEnv, subscribe, subscriptionView } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/subscription?agency_id=  plano, situação, faturas, add-ons, uso e limites. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await subscriptionView(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/subscription  { agency_id, plan, cycle?, coupon?, document?, billing_email? }  assina ou troca de plano. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL, { allowLocked: true });
    return NextResponse.json(await subscribe(subDepsFromEnv(sql, mailerFromEnv()), agencyId, userId, input));
  } catch (error) {
    return fail(error);
  }
}
