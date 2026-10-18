import { NextResponse } from "next/server";
import { z } from "zod";
import { serverIntegrations } from "@/lib/integrations";
import { discoverAccounts, linkAccount, unlinkAccount } from "@/lib/integrations/ads/sync";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

const platform = z.enum(["meta", "google", "tiktok", "ga4"]);

/** GET ?agency_id=…&platform=meta|google|tiktok|ga4[&connection_id=]  contas que a conexão enxerga, com o cliente já ligado. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const search = new URL(request.url).searchParams;
    const agencyId = uuid.parse(search.get("agency_id"));
    const p = platform.parse(search.get("platform"));
    const connectionId = search.get("connection_id") ? uuid.parse(search.get("connection_id")) : undefined;
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json({ accounts: await discoverAccounts({ sql, ...serverIntegrations() }, agencyId, p, connectionId) });
  } catch (error) {
    return fail(error);
  }
}

const link = z.object({
  agency_id: uuid,
  client_id: uuid,
  platform,
  external_id: z.string().trim().min(1).max(80),
  name: z.string().max(200).optional(),
  currency: z.string().max(8).optional(),
  connection_id: uuid,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** POST { agency_id, client_id, platform, external_id, connection_id, name?, currency?, metadata? }  liga a conta ao cliente. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const input = link.parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, input.agency_id, CAN_MANAGE);
    const id = await linkAccount(sql, {
      agencyId: input.agency_id,
      clientId: input.client_id,
      platform: input.platform,
      externalId: input.external_id,
      name: input.name,
      currency: input.currency,
      connectionId: input.connection_id,
      metadata: input.metadata,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE ?agency_id=…&id=…  desliga a conta do cliente (as métricas já sincronizadas ficam). */
export async function DELETE(request: Request) {
  try {
    const userId = await requireUser(request);
    const search = new URL(request.url).searchParams;
    const agencyId = uuid.parse(search.get("agency_id"));
    const id = uuid.parse(search.get("id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    await unlinkAccount(sql, agencyId, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
