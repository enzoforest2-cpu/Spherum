import { NextResponse } from "next/server";
import { z } from "zod";
import { serverIntegrations } from "@/lib/integrations";
import { syncAccount, syncWindow, type AccountRow } from "@/lib/integrations/ads/sync";
import { one } from "@/lib/xodos/db";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { XodoError } from "@/lib/xodos/runner";

export const maxDuration = 300;

/** POST { agency_id, account_id }  sincroniza uma conta agora (30 dias na primeira vez, 3 nas seguintes). */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const input = z.object({ agency_id: uuid, account_id: uuid }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, input.agency_id, CAN_USE, { area: "campanhas" });
    const row = await one<AccountRow>(sql, `select * from client_ad_accounts where id = $1 and agency_id = $2`, [input.account_id, input.agency_id]);
    if (!row) throw new XodoError("Conta não encontrada", 404);
    const { since, until } = syncWindow(row, new Date());
    const rows = await syncAccount({ sql, ...serverIntegrations() }, row, since, until);
    return NextResponse.json({ rows, since, until });
  } catch (error) {
    return fail(error);
  }
}
