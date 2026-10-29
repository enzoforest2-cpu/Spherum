import { NextResponse } from "next/server";
import { documentsStorage, finishUpload } from "@/lib/core/documents";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/documents/:id/finish  { agency_id }  confirma que o arquivo subiu e libera o documento. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const agencyId = uuid.parse((await request.json())?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "clientes" });
    return NextResponse.json({ document: await finishUpload(sql, documentsStorage(), agencyId, userId, id) });
  } catch (error) {
    return fail(error);
  }
}
