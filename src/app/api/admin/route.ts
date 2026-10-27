import { NextResponse } from "next/server";
import { adminBoard } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser } from "@/lib/xodos/http";

/** GET /api/admin  tudo o que as telas do admin mostram (só a equipe do Spherum). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    return NextResponse.json(await adminBoard(sql, userId, role));
  } catch (error) {
    return fail(error);
  }
}
