import { NextResponse } from "next/server";
import { removeStaff, updateStaff } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/admin/staff/:userId  { role }  ·  DELETE tira da equipe. A equipe nunca fica sem dono. */
export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    await updateStaff(sql, { id: userId, role }, uuid.parse((await params).userId), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    await removeStaff(sql, { id: userId, role }, uuid.parse((await params).userId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
