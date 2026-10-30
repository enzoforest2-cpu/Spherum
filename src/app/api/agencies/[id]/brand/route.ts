import { NextResponse } from "next/server";
import { brandOf, setBrand, setLogo } from "@/lib/core/brand";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agencies/:id/brand  a marca como vale no plano de agora. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "configuracoes" });
    return NextResponse.json({ brand: await brandOf(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/agencies/:id/brand  { name?, on_client?, on_agency?, side?, powered? } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json({ brand: await setBrand(sql, agencyId, userId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/agencies/:id/brand  { logo: "data:image/png;base64,…" | null }  troca ou tira a logo. */
export async function PUT(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json({ brand: await setLogo(sql, agencyId, userId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}
