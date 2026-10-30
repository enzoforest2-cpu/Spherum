import { NextResponse } from "next/server";
import { createApiKey, listApiKeys } from "@/lib/core/public-api";
import { apiEnabled } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agencies/:id/api-keys  chaves da agência (sem a chave em si) e se o plano inclui a API. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "configuracoes" });
    return NextResponse.json({ enabled: await apiEnabled(sql, agencyId), keys: await listApiKeys(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/agencies/:id/api-keys  { name, scopes?: ["read"] | ["read", "write"] }  devolve a chave inteira uma única vez. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json({ key: await createApiKey(sql, agencyId, userId, await request.json()) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
