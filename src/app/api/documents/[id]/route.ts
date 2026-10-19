import { NextResponse } from "next/server";
import { deleteDocument, documentsStorage, updateDocument } from "@/lib/core/documents";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/documents/:id  { agency_id, name?, category?, shared? } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ document: await updateDocument(sql, agencyId, id, input) });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/documents/:id?agency_id=…  apaga o arquivo e o registro. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    await deleteDocument(sql, documentsStorage(), agencyId, userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
