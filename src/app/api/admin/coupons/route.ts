import { NextResponse } from "next/server";
import { createCoupon } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail } from "@/lib/xodos/http";

/** POST /api/admin/coupons  { code, description, kind, value, months?, plans?, max_uses?, valid_until?, note? } */
export async function POST(request: Request) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    return NextResponse.json(await createCoupon(sql, { id: userId, role }, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
