import { after, NextResponse } from "next/server";
import { z } from "zod";
import { ADAPTERS } from "@/lib/channels";
import { deliverRun } from "@/lib/channels/manage";
import type { ChannelDeps } from "@/lib/channels/types";
import { computerDeps } from "@/lib/computer";
import { releaseByLink, withEngine } from "@/lib/computer/control";
import { productionDeps } from "@/lib/xodos";
import { fail } from "@/lib/xodos/http";

export const maxDuration = 300;

const input = z.object({ token: z.string().trim().min(1).max(200) });

/**
 * POST { token }  devolve o controle pelo link de uso único (para quem está no Slack ou no
 * WhatsApp). Sem login: o token vale só para aquele lease. Só POST, para a prévia de link do
 * chat não devolver sozinha.
 */
export async function POST(request: Request) {
  try {
    const { token } = input.parse(await request.json());
    const engine = await productionDeps();
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
    const result = await releaseByLink(deps, token);
    return NextResponse.json({ ok: true, resumed: result.resumed !== null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return fail(error);
  }
}
