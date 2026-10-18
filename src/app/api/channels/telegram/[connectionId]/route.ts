import { after, NextResponse } from "next/server";
import { ADAPTERS, channelDeps } from "@/lib/channels";
import { readBody } from "@/lib/channels/security";
import { handleTelegramUpdate, telegramHookFor } from "@/lib/channels/telegram";
import { ChannelError, integrationDepsOf } from "@/lib/channels/types";

/**
 * Webhook do bot do Telegram de uma conexão da agência (o endereço que o Spherum registra com
 * setWebhook ao conectar).
 *
 * O Telegram manda em todo POST o segredo da conexão (X-Telegram-Bot-Api-Secret-Token); sem ele,
 * ou com a conexão inexistente, a resposta é o mesmo 401. Respondemos 200 na hora e o xodó
 * trabalha depois (after): o Telegram reenvia o que demora a ser confirmado.
 */

// Depois da resposta, uma execução do xodó pode levar alguns minutos.
export const maxDuration = 300;

type Params = { params: Promise<{ connectionId: string }> };

const unauthorized = () => NextResponse.json({ error: "Não autorizado" }, { status: 401 });

export async function POST(request: Request, { params }: Params) {
  try {
    const { connectionId } = await params;
    const header = request.headers.get("x-telegram-bot-api-secret-token");
    if (!header) return unauthorized();
    const deps = await channelDeps();
    const hook = await telegramHookFor(integrationDepsOf(deps), connectionId, header);
    if (!hook) return unauthorized();
    const body = await readBody(request);
    let update: unknown;
    try {
      update = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
    }
    after(() =>
      handleTelegramUpdate(deps, ADAPTERS, hook, update).catch((error) =>
        console.error("[canais] telegram: processamento falhou", hook.id, error instanceof Error ? error.message : error),
      ),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChannelError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[canais] telegram: entrada falhou", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
