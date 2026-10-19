import { NextResponse } from "next/server";
import { createSandboxKey, listSandboxKeys } from "@/lib/computer/manage";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

/**
 * Chaves da máquina (E2B, Daytona) no mesmo cofre das chaves de modelo. A chave entra uma vez e
 * nunca mais sai: só os 4 últimos dígitos. Para revogar, a mesma rota das outras chaves.
 */

/** GET ?agency_id=… */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json({ keys: await listSandboxKeys(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST { agency_id, provider: "e2b"|"daytona", label, api_key } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id ?? new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    const key = await createSandboxKey(sql, agencyId, body, userId, masterKeyFromEnv());
    return NextResponse.json({ key }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
