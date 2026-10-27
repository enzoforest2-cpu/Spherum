import { NextResponse } from "next/server";
import { createCoupon } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser } from "@/lib/xodos/http";

/** POST /api/admin/coupons  { code, description, kind, value, months?, plans?, max_uses?, valid_until?, note? } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    return NextResponse.json(await createCoupon(sql, { id: userId, role }, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
