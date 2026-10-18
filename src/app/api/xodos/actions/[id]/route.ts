import { after, NextResponse } from "next/server";
import { z } from "zod";
import { ADAPTERS } from "@/lib/channels";
import { deliverRun } from "@/lib/channels/manage";
import type { ChannelDeps } from "@/lib/channels/types";
import { one } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { decideAction, productionDeps, resumeRun } from "@/lib/xodos";
import { XodoError } from "@/lib/xodos/runner";

export const maxDuration = 300;

const decision = z.object({
  approve: z.boolean(),
  scope: z.enum(["once", "always"]).default("once"),
  reason: z.string().max(500).optional(),
});

/**
 * POST /api/xodos/actions/:id  { approve, scope?, reason? }
 * O corpo só decide; o que roda é o pedido guardado no servidor, uma única vez.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const actionId = uuid.parse((await params).id);
    const body = decision.parse(await request.json());
    const deps = await productionDeps();
    const action = await one<{ agency_id: string }>(deps.sql, `select agency_id from xodo_actions where id = $1`, [actionId]);
    if (!action) throw new XodoError("Pedido não encontrado", 404);
    await requireRole(deps.sql, userId, action.agency_id, CAN_USE);
    const result = await decideAction(deps, { actionId, agencyId: action.agency_id, userId, ...body });
    after(async () => {
      try {
        await resumeRun(deps, result.runId);
      } catch (error) {
        console.error("[xodos] retomada falhou", result.runId, error);
      } finally {
        // Se a conversa é de um canal (Slack, WhatsApp, Telegram), entrega por lá o que houver.
        await deliverRun(deps as ChannelDeps, ADAPTERS, result.runId).catch((error) =>
          console.error("[canais] entrega falhou", result.runId, error),
        );
      }
    });
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
