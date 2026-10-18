import { after, NextResponse } from "next/server";
import { ADAPTERS, channelDeps } from "@/lib/channels";
import { readBody, verifyHubSignature } from "@/lib/channels/security";
import { ChannelError, integrationDepsOf } from "@/lib/channels/types";
import { handleWhatsappCloud, loadWhatsappCloudWebhook, verifyWhatsappChallenge } from "@/lib/channels/whatsapp-cloud";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { uuid } from "@/lib/xodos/http";

/**
 * Webhook do WhatsApp oficial de uma conexão da agência (o endereço que ela cola no painel da Meta).
 *
 * GET: a Meta confirma o endereço com o token de verificação da conexão.
 * POST: mensagens, assinadas com a chave secreta do app (X-Hub-Signature-256 sobre o corpo cru).
 * Respondemos 200 na hora e o xodó trabalha depois (after): a Meta reenvia o que demora.
 */

// Depois da resposta, uma execução do xodó pode levar alguns minutos.
export const maxDuration = 300;

type Params = { params: Promise<{ connectionId: string }> };

const forbidden = () => new Response("Proibido", { status: 403 });

export async function GET(request: Request, { params }: Params) {
  try {
    const { connectionId } = await params;
    if (!uuid.safeParse(connectionId).success) return forbidden();
    const hook = await loadWhatsappCloudWebhook({ sql: await serverSql(), ...serverIntegrations() }, connectionId);
    const challenge = hook ? verifyWhatsappChallenge(new URL(request.url).searchParams, hook.verifyToken) : null;
    if (!challenge) return forbidden();
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } catch (error) {
    console.error("[canais] whatsapp: verificação falhou", error instanceof Error ? error.message : error);
    return new Response("Erro interno", { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { connectionId } = await params;
    if (!uuid.safeParse(connectionId).success) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
    const body = await readBody(request);
    const deps = await channelDeps();
    const hook = await loadWhatsappCloudWebhook(integrationDepsOf(deps), connectionId);
    if (!hook) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
    if (!verifyHubSignature(hook.appSecret, request.headers.get("x-hub-signature-256"), body)) {
      return NextResponse.json({ error: "Assinatura inválida" }, { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
    }
    after(() =>
      handleWhatsappCloud(deps, ADAPTERS, hook, payload).catch((error) =>
        console.error("[canais] whatsapp: processamento falhou", hook.id, error instanceof Error ? error.message : error),
      ),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChannelError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[canais] whatsapp: entrada falhou", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
