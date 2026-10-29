import { NextResponse } from "next/server";
import { setCatalog } from "@/lib/core/proposals";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/agencies/:id/proposal-catalog  { catalog: [...] }  catálogo de serviços das propostas. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "comercial" });
    const { catalog } = await request.json();
    await setCatalog(sql, agencyId, catalog);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
