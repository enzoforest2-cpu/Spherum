import { NextResponse } from "next/server";
import { createTelegramConnection } from "@/lib/channels/telegram";
import { createWhatsappCloudConnection } from "@/lib/channels/whatsapp-cloud";
import { createWhatsappQrConnection, WHATSAPP_QR_RISKS } from "@/lib/channels/whatsapp-qr";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { XodoError } from "@/lib/xodos/runner";

/**
 * Canais que se conectam por chave (o Slack conecta pelo login em /api/integrations/slack/start).
 *
 * GET  /api/channels/connections  riscos do WhatsApp por QR Code, para a tela mostrar antes.
 * POST /api/channels/connections  { agency_id, provider, ... }
 *   telegram:       { token, label? }
 *   whatsapp_cloud: { phone_number_id, access_token, app_secret, label? }  devolve a URL e o token de verificação do webhook
 *   whatsapp_qr:    { base_url, api_key, instance?, label?, accept_risks: true }  devolve o QR Code
 */
export async function GET() {
  return NextResponse.json({ whatsapp_qr_risks: WHATSAPP_QR_RISKS });
}

export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    const deps = { sql, ...serverIntegrations() };
    switch (body?.provider) {
      case "telegram":
        return NextResponse.json({ connection: await createTelegramConnection(deps, agencyId, body, userId) }, { status: 201 });
      case "whatsapp_cloud":
        return NextResponse.json({ connection: await createWhatsappCloudConnection(deps, agencyId, body, userId) }, { status: 201 });
      case "whatsapp_qr":
        return NextResponse.json({ connection: await createWhatsappQrConnection(deps, agencyId, body, userId) }, { status: 201 });
      default:
        throw new XodoError("Canal desconhecido. Use telegram, whatsapp_cloud ou whatsapp_qr.");
    }
  } catch (error) {
    return fail(error);
  }
}
