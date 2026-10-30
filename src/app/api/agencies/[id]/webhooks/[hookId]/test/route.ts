import { NextResponse } from "next/server";
import { testWebhook } from "@/lib/core/webhooks";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string; hookId: string }> };

/** POST /api/agencies/:id/webhooks/:hookId/test  manda agora um evento "webhook.test" assinado e diz como o endereço respondeu. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const p = await params;
    const agencyId = uuid.parse(p.id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json(await testWebhook(sql, agencyId, uuid.parse(p.hookId), fetch));
  } catch (error) {
    return fail(error);
  }
}
