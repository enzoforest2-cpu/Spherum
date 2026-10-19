import { NextResponse } from "next/server";
import { z } from "zod";
import { computerDeps } from "@/lib/computer";
import { heartbeat } from "@/lib/computer/control";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser } from "@/lib/xodos/http";

export const maxDuration = 60;

const input = z.object({ agency_id: z.uuid(), lease_id: z.uuid() });

/** POST { agency_id, lease_id }  renova o controle por mais 15 minutos (até 2 horas). A cada 30 s. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const { agency_id: agencyId, lease_id: leaseId } = input.parse({ ...body, agency_id: body?.agency_id ?? new URL(request.url).searchParams.get("agency_id") });
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    const renewed = await heartbeat(computerDeps(sql), agencyId, userId, leaseId);
    return NextResponse.json({ expires_at: renewed.expiresAt });
  } catch (error) {
    return fail(error);
  }
}
