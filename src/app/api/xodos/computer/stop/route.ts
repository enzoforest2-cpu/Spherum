import { NextResponse } from "next/server";
import { computerDeps } from "@/lib/computer";
import { stopComputer } from "@/lib/computer/manage";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

export const maxDuration = 300;

/** POST { agency_id }  pausa a máquina (disco e, no E2B, memória ficam guardados). */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json().catch(() => ({}));
    const agencyId = uuid.parse(body?.agency_id ?? new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "xodos" });
    return NextResponse.json(await stopComputer(computerDeps(sql), agencyId, userId));
  } catch (error) {
    return fail(error);
  }
}
