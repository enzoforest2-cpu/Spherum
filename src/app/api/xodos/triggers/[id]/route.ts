import { NextResponse } from "next/server";
import { channelDeps } from "@/lib/channels";
import { deleteTrigger, triggerAgency, updateTrigger } from "@/lib/channels/triggers";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { XodoError } from "@/lib/xodos/runner";

type Params = { params: Promise<{ id: string }> };

/** Agência do gatilho com o papel conferido (mesmo 404 para "não existe" e "não é seu"). */
async function managed(request: Request, params: Params["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const deps = await channelDeps();
  const agencyId = await triggerAgency(deps.sql, id);
  if (!agencyId) throw new XodoError("Gatilho não encontrado", 404);
  await requireRole(deps.sql, userId, agencyId, CAN_MANAGE);
  return { deps, id, agencyId };
}

/** PATCH /api/xodos/triggers/:id  { name?, instructions?, filters?, connection_id?, autonomy_cap?, max_per_hour?, enabled? }  o tipo não muda. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { deps, id, agencyId } = await managed(request, params);
    return NextResponse.json({ trigger: await updateTrigger(deps, agencyId, id, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/xodos/triggers/:id */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const { deps, id, agencyId } = await managed(request, params);
    await deleteTrigger(deps, agencyId, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
