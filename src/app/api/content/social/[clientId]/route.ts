import { NextResponse } from "next/server";
import { linkSocial, unlinkSocial } from "@/lib/core/content";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ clientId: string }> };

/** PUT /api/content/social/:clientId  { agency_id, connection_id, page_id, page_name?, ig_user_id?, ig_username? }  liga os perfis do cliente. */
export async function PUT(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).clientId);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
    await linkSocial(sql, agencyId, clientId, input);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/content/social/:clientId?agency_id=  desliga os perfis do cliente. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).clientId);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
    await unlinkSocial(sql, agencyId, clientId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
