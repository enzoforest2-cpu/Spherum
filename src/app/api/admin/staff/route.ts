import { NextResponse } from "next/server";
import { addStaff } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser } from "@/lib/xodos/http";

/** POST /api/admin/staff  { email, role }  a pessoa precisa já ter conta no Spherum. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    return NextResponse.json(await addStaff(sql, { id: userId, role }, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
