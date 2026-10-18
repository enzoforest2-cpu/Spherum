import { NextResponse } from "next/server";
import { channelDeps } from "@/lib/channels";
import { rotateTriggerSecret, triggerAgency } from "@/lib/channels/triggers";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { XodoError } from "@/lib/xodos/runner";

/** POST /api/xodos/triggers/:id/rotate  troca o segredo do webhook ou do GitHub; o antigo para de valer na hora. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const deps = await channelDeps();
    const agencyId = await triggerAgency(deps.sql, id);
    if (!agencyId) throw new XodoError("Gatilho não encontrado", 404);
    await requireRole(deps.sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json(await rotateTriggerSecret(deps, agencyId, id));
  } catch (error) {
    return fail(error);
  }
}
