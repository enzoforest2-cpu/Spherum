import { NextResponse } from "next/server";
import { APPS } from "@/lib/integrations/apps";
import { createMcpConnection } from "@/lib/integrations/connections";
import { serverIntegrations } from "@/lib/integrations";
import { OAUTH_PROVIDERS } from "@/lib/integrations/oauth-providers";
import { listConnections } from "@/lib/integrations/store";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { XodoError } from "@/lib/xodos/runner";

/** GET /api/integrations?agency_id=…  conexões da agência e o catálogo de apps (com o que já está configurado no Spherum). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "configuracoes" });
    const apps = Object.entries(APPS).map(([id, info]) => ({
      id,
      label: info.label,
      providers: info.providers.map((p) => ({
        id: p,
        oauth: Boolean(OAUTH_PROVIDERS[p]),
        // Login por OAuth só funciona depois que o app do Spherum na plataforma for configurado.
        configured: OAUTH_PROVIDERS[p] ? Boolean(process.env[OAUTH_PROVIDERS[p].env.clientId]) : true,
      })),
    }));
    return NextResponse.json({ connections: await listConnections(sql, agencyId), apps });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/integrations  conexões por chave. Hoje: { agency_id, provider: "mcp", label, url, token? }. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    if (body?.provider !== "mcp") throw new XodoError("Tipo de conexão desconhecido.");
    const connection = await createMcpConnection({ sql, ...serverIntegrations() }, agencyId, body, userId);
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
