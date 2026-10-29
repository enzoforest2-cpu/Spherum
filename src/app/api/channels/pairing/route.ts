import { NextResponse } from "next/server";
import { z } from "zod";
import { createPairingCode, PAIRING_TTL_MS } from "@/lib/channels/pairing";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/**
 * POST /api/channels/pairing  { agency_id }
 * Gera o código de pareamento da pessoa logada (8 caracteres, 10 minutos, uso único). Ela manda
 * o código para o xodó no Slack, WhatsApp ou Telegram e passa a ser atendida por lá.
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id: agencyId } = z.object({ agency_id: uuid }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "xodos" });
    const { code, expiresAt } = await createPairingCode(sql, agencyId, userId, new Date());
    return NextResponse.json({
      code,
      expires_at: expiresAt.toISOString(),
      valid_minutes: PAIRING_TTL_MS / 60_000,
      instructions: `Mande ${code} para o xodó no canal (no Telegram também vale /start ${code}).`,
    });
  } catch (error) {
    return fail(error);
  }
}
