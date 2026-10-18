import { after, NextResponse } from "next/server";
import { channelDeps } from "@/lib/channels";
import { readBody } from "@/lib/channels/security";
import { receiveHook } from "@/lib/channels/triggers";
import { ChannelError } from "@/lib/channels/types";
import { continueRun } from "@/lib/xodos/runner";

/**
 * POST /api/hooks/:id  entrada dos gatilhos "webhook" (segredo em Authorization: Bearer ou
 * X-Spherum-Secret) e "github" (assinatura X-Hub-Signature-256).
 *
 * Lê o corpo cru com limite (a assinatura do GitHub é sobre ele), responde na hora e o xodó
 * trabalha depois (after). Gatilho inexistente, desligado ou com segredo errado: o mesmo 401.
 */

// Depois da resposta, uma execução do xodó pode levar alguns minutos.
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readBody(request);
    const deps = await channelDeps();
    const result = await receiveHook(deps, id, { headers: request.headers, body });
    const runId = result.runId;
    if (runId) {
      after(() =>
        continueRun(deps, runId).catch((error) =>
          console.error("[gatilhos] execução falhou", runId, error instanceof Error ? error.message : error),
        ),
      );
    }
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof ChannelError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[gatilhos] entrada falhou", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
