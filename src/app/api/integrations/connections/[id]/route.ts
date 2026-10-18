import { NextResponse } from "next/server";
import { deleteTelegramWebhook } from "@/lib/channels/telegram";
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
    // O Telegram para de mandar mensagens para o Spherum antes de a conexão sumir.
    if (conn?.provider === "telegram") {
      await deleteTelegramWebhook(deps, agencyId, connectionId).catch((error) =>
        console.warn("[canais] não consegui remover o webhook do Telegram", error instanceof Error ? error.message : error),
      );
    }
    await revokeConnection(deps, agencyId, connectionId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
