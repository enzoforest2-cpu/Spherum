import { after, NextResponse } from "next/server";
import { channelDeps } from "@/lib/channels";
import { readBody } from "@/lib/channels/security";
import { receiveHook } from "@/lib/channels/triggers";
import { ChannelError } from "@/lib/channels/types";
import { continueRun } from "@/lib/xodos/runner";

/**
 * POST /api/hooks/:id/:secret  o mesmo gatilho "webhook", com o segredo no caminho, para
 * sistemas que só deixam colar uma URL (sem cabeçalho). O segredo nunca vai para o log.
 */

// Depois da resposta, uma execução do xodó pode levar alguns minutos.
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string; secret: string }> }) {
  try {
    const { id, secret } = await params;
    const body = await readBody(request);
    const deps = await channelDeps();
    const result = await receiveHook(deps, id, { headers: request.headers, body, pathSecret: secret });
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
