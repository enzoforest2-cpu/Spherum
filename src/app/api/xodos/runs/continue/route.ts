import { timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { ADAPTERS } from "@/lib/channels";
import { deliverRun } from "@/lib/channels/manage";
import type { ChannelDeps } from "@/lib/channels/types";
import { productionDeps } from "@/lib/xodos";
import { fail } from "@/lib/xodos/http";
import { continueSlice } from "@/lib/xodos/runner";

export const maxDuration = 300;

/**
 * POST /api/xodos/runs/continue  { run_id }  com "Authorization: Bearer $CRON_SECRET".
 * Só o próprio servidor chama: continua a fatia seguinte de uma execução que parou no prazo.
 * Responde na hora; a fatia roda depois da resposta (e, se parar de novo, encadeia a próxima).
 */
export async function POST(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    const given = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${secret}`;
    if (!secret || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }
    const { run_id: runId } = z.object({ run_id: z.uuid() }).parse(await request.json());
    const deps = await productionDeps();
    after(async () => {
      try {
        await continueSlice(deps, runId);
      } catch (error) {
        console.error("[xodos] fatia falhou", runId, error);
      } finally {
        await deliverRun(deps as ChannelDeps, ADAPTERS, runId).catch((error) => console.error("[canais] entrega falhou", runId, error));
      }
    });
    return NextResponse.json({ run_id: runId }, { status: 202 });
  } catch (error) {
    return fail(error);
  }
}
