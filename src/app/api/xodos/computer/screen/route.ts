import { NextResponse } from "next/server";
import { computerDeps } from "@/lib/computer";
import { screenUrls } from "@/lib/computer/control";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

export const maxDuration = 60;

/**
 * GET /api/xodos/computer/screen?agency_id=…  URL da tela ao vivo (token de 15 minutos no
 * fragmento, só leitura); para quem está no controle, também as de controle e terminal.
 * Com a máquina pausada não liga nada.
 */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    const role = await requireRole(sql, userId, agencyId, CAN_READ);
    const screen = await screenUrls(computerDeps(sql), agencyId, userId, role);
    return NextResponse.json(screen, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    return fail(error);
  }
}
