import { NextResponse } from "next/server";
import { whatsappQrStatus } from "@/lib/channels/whatsapp-qr";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/channels/connections/:id/status?agency_id=…  situação do WhatsApp por QR Code (e um QR novo, se precisar). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const connectionId = uuid.parse((await params).id);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json(await whatsappQrStatus({ sql, ...serverIntegrations() }, agencyId, connectionId));
  } catch (error) {
    return fail(error);
  }
}
