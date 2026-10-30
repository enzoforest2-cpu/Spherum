import { NextResponse } from "next/server";
import { adminDeps } from "@/lib/core/admin-deps";
import { viewAgency } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail, uuid } from "@/lib/xodos/http";

/**
 * GET /api/admin/agencies/:id/view?ticket=  a conta da agência como o dono vê, só para ler
 * (suporte, operação e dono). Entra na auditoria e avisa a agência no app.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    const ticket = new URL(request.url).searchParams.get("ticket") || undefined;
    return NextResponse.json(await viewAgency(adminDeps(sql), { id: userId, role }, uuid.parse((await params).id), { ticket }));
  } catch (error) {
    return fail(error);
  }
}
