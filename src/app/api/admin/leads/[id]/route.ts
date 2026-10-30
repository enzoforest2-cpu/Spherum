import { NextResponse } from "next/server";
import { updateSiteLead } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail, uuid } from "@/lib/xodos/http";

/** PATCH /api/admin/leads/:id  { stage?, owner_user?, note? } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    await updateSiteLead(sql, { id: userId, role }, uuid.parse((await params).id), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
