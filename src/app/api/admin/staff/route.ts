import { NextResponse } from "next/server";
import { addStaff } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail } from "@/lib/xodos/http";

/** POST /api/admin/staff  { email, role }  a pessoa precisa já ter conta no Spherum. */
export async function POST(request: Request) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    return NextResponse.json(await addStaff(sql, { id: userId, role }, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
