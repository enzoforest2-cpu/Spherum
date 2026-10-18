import { NextResponse } from "next/server";
import { deleteTelegramWebhook } from "@/lib/channels/telegram";
import { disconnectWhatsappQr } from "@/lib/channels/whatsapp-qr";
import { serverIntegrations } from "@/lib/integrations";
import { revokeConnection } from "@/lib/integrations/store";
import { one, serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/integrations/connections/:id?agency_id=…  desconecta (revoga na plataforma quando dá e apaga os tokens). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const connectionId = uuid.parse((await params).id);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    const deps = { sql, ...serverIntegrations() };
    const conn = await one<{ provider: string }>(sql, `select provider from integration_connections where id = $1 and agency_id = $2`, [
      connectionId,
      agencyId,
    ]);
    // Telegram e gateway do WhatsApp param de mandar mensagens para o Spherum antes de a conexão sumir.
    const unhook =
      conn?.provider === "telegram"
        ? deleteTelegramWebhook(deps, agencyId, connectionId)
        : conn?.provider === "whatsapp_qr"
          ? disconnectWhatsappQr(deps, agencyId, connectionId)
          : null;
    await unhook?.catch((error: unknown) =>
      console.warn("[canais] não consegui desligar o canal na plataforma", error instanceof Error ? error.message : error),
    );
    await revokeConnection(deps, agencyId, connectionId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
