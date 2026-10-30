import { NextResponse } from "next/server";
import { removeStaff, updateStaff } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail, uuid } from "@/lib/xodos/http";

/** PATCH /api/admin/staff/:userId  { role }  ·  DELETE tira da equipe. A equipe nunca fica sem dono. */
export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    await updateStaff(sql, { id: userId, role }, uuid.parse((await params).userId), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    await removeStaff(sql, { id: userId, role }, uuid.parse((await params).userId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
