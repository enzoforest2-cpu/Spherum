import { NextResponse } from "next/server";
import { documentsStorage, listDocuments, startUpload } from "@/lib/core/documents";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/documents?agency_id=…[&client_id=…]  documentos da agência (ou de um cliente). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const search = new URL(request.url).searchParams;
    const agencyId = uuid.parse(search.get("agency_id"));
    const clientId = search.get("client_id") ? uuid.parse(search.get("client_id")) : null;
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ documents: await listDocuments(sql, agencyId, clientId) });
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/documents  { agency_id, client_id?, name, category, mime, size, shared }
 * Devolve { id, upload_url }: o navegador sobe o arquivo com PUT e chama /finish.
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json(await startUpload(sql, documentsStorage(), agencyId, userId, input), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
