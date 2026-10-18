import { NextResponse } from "next/server";
import { channelDeps } from "@/lib/channels";
import { createTrigger, listTriggers } from "@/lib/channels/triggers";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { loadXodo } from "@/lib/xodos/runner";

/** GET /api/xodos/:id/triggers  gatilhos do xodó com as últimas entregas (sem segredos). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const deps = await channelDeps();
    const xodo = await loadXodo(deps.sql, xodoId);
    await requireRole(deps.sql, userId, xodo.agency_id, CAN_READ);
    return NextResponse.json({ triggers: await listTriggers(deps, xodo.agency_id, xodoId) });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/xodos/:id/triggers  { kind, name, instructions?, filters?, connection_id?, autonomy_cap?,
 * max_per_hour?, enabled? }. Webhook e GitHub devolvem { secret, url }: o segredo aparece só aqui.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const deps = await channelDeps();
    const xodo = await loadXodo(deps.sql, xodoId);
    await requireRole(deps.sql, userId, xodo.agency_id, CAN_MANAGE);
    const created = await createTrigger(deps, xodo.agency_id, xodoId, await request.json(), userId);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
