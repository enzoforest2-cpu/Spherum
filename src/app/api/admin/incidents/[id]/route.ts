import { NextResponse } from "next/server";
import { updateIncident } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail, uuid } from "@/lib/xodos/http";

/** PATCH /api/admin/incidents/:id  { status, text }  atualização (resolved encerra). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    await updateIncident(sql, { id: userId, role }, uuid.parse((await params).id), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
