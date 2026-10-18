import { after, NextResponse } from "next/server";
import { ADAPTERS, channelDeps } from "@/lib/channels";
import { handleSlackInteraction, parseInteractionBody, readSlackRequest } from "@/lib/channels/slack";
import { ChannelError } from "@/lib/channels/types";

// Aprovar retoma o xodó dentro do after(); pode levar alguns minutos.
export const maxDuration = 300;

/**
 * POST /api/channels/slack/interactions  cliques nos botões "Aprovar" e "Negar". Mesma
 * assinatura dos eventos; responde 200 na hora e decide depois, atualizando a mensagem pelo
 * response_url.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = parseInteractionBody(await readSlackRequest(request, process.env.SLACK_SIGNING_SECRET));
  } catch (error) {
    if (error instanceof ChannelError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  after(async () => {
    try {
      await handleSlackInteraction(await channelDeps(), ADAPTERS, payload);
    } catch (error) {
      console.error("[canais] slack: interação falhou", error instanceof Error ? error.message : error);
    }
  });
  return new NextResponse(null, { status: 200 });
}
