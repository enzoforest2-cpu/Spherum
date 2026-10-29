import { NextResponse } from "next/server";
import { computerDeps } from "@/lib/computer";
import { takeControl } from "@/lib/computer/control";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

export const maxDuration = 300;

/**
 * POST { agency_id }  assume o controle do computador por 15 minutos (renove com heartbeat).
 * Uma pessoa por vez; owner e admin podem tomar de outra. Devolve as URLs de controle e
 * terminal (token no fragmento) e o token do link de devolução (POST …/release-link).
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json().catch(() => ({}));
    const agencyId = uuid.parse(body?.agency_id ?? new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "xodos" });
    const grant = await takeControl(computerDeps(sql), agencyId, userId);
    return NextResponse.json(
      {
        lease_id: grant.leaseId,
        expires_at: grant.expiresAt,
        run_id: grant.runId,
        view_url: grant.viewUrl,
        terminal_url: grant.terminalUrl,
        release_token: grant.releaseToken,
        revoked_user_id: grant.revokedUserId,
      },
      { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
    );
  } catch (error) {
    return fail(error);
  }
}
