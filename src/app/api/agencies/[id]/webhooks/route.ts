import { NextResponse } from "next/server";
import { apiEnabled } from "@/lib/core/subscription";
import { createWebhook, listWebhooks, WEBHOOK_EVENTS } from "@/lib/core/webhooks";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agencies/:id/webhooks  endereços cadastrados, eventos disponíveis e se o plano inclui. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "configuracoes" });
    return NextResponse.json({ enabled: await apiEnabled(sql, agencyId), events: WEBHOOK_EVENTS, webhooks: await listWebhooks(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/agencies/:id/webhooks  { url: "https://…", events: [...], description? }  devolve o segredo de assinatura uma única vez. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json(await createWebhook(sql, agencyId, userId, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
