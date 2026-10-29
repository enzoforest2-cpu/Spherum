import { after, NextResponse } from "next/server";
import { z } from "zod";
import { ADAPTERS } from "@/lib/channels";
import { deliverRun } from "@/lib/channels/manage";
import type { ChannelDeps } from "@/lib/channels/types";
import { computerDeps } from "@/lib/computer";
import { release, withEngine } from "@/lib/computer/control";
import { productionDeps } from "@/lib/xodos";
import { CAN_USE, fail, requireRole, requireUser } from "@/lib/xodos/http";

export const maxDuration = 300;

const input = z.object({
  agency_id: z.uuid(),
  reason: z.enum(["done", "skipped"]).default("done"),
  lease_id: z.uuid().optional(),
});

/**
 * POST { agency_id, reason: "done"|"skipped", lease_id? }  devolve o controle (owner e admin
 * podem devolver o de outra pessoa). O xodó que esperava continua depois da resposta.
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const parsed = input.parse({ ...body, agency_id: body?.agency_id ?? new URL(request.url).searchParams.get("agency_id") });
    const engine = await productionDeps();
    await requireRole(engine.sql, userId, parsed.agency_id, CAN_USE, { area: "xodos" });
    const deps = withEngine(computerDeps(engine.sql), engine, (runId, task) =>
      after(async () => {
        try {
          await task();
        } catch (error) {
          console.error("[computador] retomada falhou", runId, error);
        } finally {
          await deliverRun(engine as ChannelDeps, ADAPTERS, runId).catch((error) => console.error("[canais] entrega falhou", runId, error));
        }
      }),
    );
    const result = await release(deps, parsed.agency_id, userId, parsed.reason, parsed.lease_id);
    return NextResponse.json({ run_id: result.runId, resumed: result.resumed !== null });
  } catch (error) {
    return fail(error);
  }
}
