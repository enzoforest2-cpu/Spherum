import { NextResponse } from "next/server";
import { z } from "zod";
import { APP_IDS, type AppId } from "@/lib/integrations/apps";
import { serverIntegrations } from "@/lib/integrations";
import { startOAuth } from "@/lib/integrations/oauth";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

const body = z.object({
  agency_id: uuid,
  apps: z.array(z.enum(APP_IDS as [AppId, ...AppId[]])).min(1).max(10),
  return_to: z.string().max(300).optional(),
});

/**
 * POST /api/integrations/:provider/start  { agency_id, apps: ["gmail", "calendar"], return_to? }
 * Devolve { url }: o navegador vai até a plataforma e volta em /api/integrations/:provider/callback.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const userId = await requireUser(request);
    const { provider } = await params;
    const input = body.parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, input.agency_id, CAN_MANAGE);
    const url = await startOAuth(
      { sql, ...serverIntegrations() },
      { agencyId: input.agency_id, userId, provider, apps: input.apps, returnTo: input.return_to },
    );
    return NextResponse.json({ url });
  } catch (error) {
    return fail(error);
  }
}
