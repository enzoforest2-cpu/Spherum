import { after, NextResponse } from "next/server";
import { ADAPTERS, channelDeps } from "@/lib/channels";
import { readBody } from "@/lib/channels/security";
import { ChannelError } from "@/lib/channels/types";
import { authenticateWhatsappQr, handleWhatsappQr } from "@/lib/channels/whatsapp-qr";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";

/**
 * Webhook do gateway Evolution API (WhatsApp por QR Code) de uma conexão da agência.
 *
 * A Evolution não assina o que manda: quem chama prova que é o gateway pelo token no caminho,
 * comparado com o hash guardado. Token errado e conexão inexistente recebem o mesmo 401 (a
 * Evolution não insiste em 401). Respondemos 200 na hora e o xodó trabalha depois (after).
 *
 * O corpo traz a apikey da instância: nunca registre o corpo em log.
 */

// Depois da resposta, uma execução do xodó pode levar alguns minutos.
export const maxDuration = 300;

type Params = { params: Promise<{ connectionId: string; token: string }> };

const unauthorized = () => NextResponse.json({ error: "Não autorizado" }, { status: 401 });

export async function POST(request: Request, { params }: Params) {
  try {
    const { connectionId, token } = await params;
    const hook = await authenticateWhatsappQr({ sql: await serverSql(), ...serverIntegrations() }, connectionId, token);
    if (!hook) return unauthorized();
    const body = await readBody(request);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
    }
    const deps = await channelDeps();
    after(() =>
      handleWhatsappQr(deps, ADAPTERS, hook, payload).catch((error) =>
        console.error("[canais] whatsapp-qr: processamento falhou", hook.id, error instanceof Error ? error.message : error),
      ),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChannelError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[canais] whatsapp-qr: entrada falhou", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
