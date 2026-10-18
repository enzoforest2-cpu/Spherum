import { after, NextResponse } from "next/server";
import { ADAPTERS, channelDeps } from "@/lib/channels";
import { handleSlackEvent, parseSlackEvent, readSlackRequest } from "@/lib/channels/slack";
import { ChannelError } from "@/lib/channels/types";

// O xodó responde dentro do after(); uma execução pode levar alguns minutos.
export const maxDuration = 300;

/**
 * POST /api/channels/slack/events  Events API do app do Spherum (menções, mensagens diretas e
 * mensagens dos canais para os gatilhos). Confere a assinatura com o corpo cru, responde 200 na
 * hora (o Slack reenvia se passar de 3 s) e trabalha depois.
 */
export async function POST(request: Request) {
  try {
    const raw = await readSlackRequest(request, process.env.SLACK_SIGNING_SECRET);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
    }
    const event = parseSlackEvent(body);
    if (event.kind === "url_verification") return NextResponse.json({ challenge: event.challenge });
    if (event.kind !== "ignored") {
      after(async () => {
        try {
          await handleSlackEvent(await channelDeps(), ADAPTERS, event);
        } catch (error) {
          console.error("[canais] slack: evento falhou", event.eventId, error instanceof Error ? error.message : error);
        }
      });
    }
    return new NextResponse(null, { status: 200 });
  } catch (error) {
    if (error instanceof ChannelError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[canais] slack: entrada falhou", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
