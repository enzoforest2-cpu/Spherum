import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteCoupon, updateCoupon } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser } from "@/lib/xodos/http";

const code = z.string().regex(/^[A-Z0-9]{3,24}$/);

/** PATCH /api/admin/coupons/:code  { status?, max_uses?, valid_until?, description? }  ·  DELETE (só sem uso) */
export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    await updateCoupon(sql, { id: userId, role }, code.parse((await params).code), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    await deleteCoupon(sql, { id: userId, role }, code.parse((await params).code));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
