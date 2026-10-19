import { NextResponse } from "next/server";
import { documentsStorage, downloadUrl } from "@/lib/core/documents";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/documents/:id/download  { url } curta (2 min) para a equipe ou para o cliente, se estiver visível no portal. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    return NextResponse.json({ url: await downloadUrl(await serverSql(), documentsStorage(), userId, id) });
  } catch (error) {
    return fail(error);
  }
}
