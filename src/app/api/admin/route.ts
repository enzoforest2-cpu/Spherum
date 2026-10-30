import { NextResponse } from "next/server";
import { adminBoard } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail } from "@/lib/xodos/http";

/** GET /api/admin  tudo o que as telas do admin mostram (só a equipe do Spherum). */
export async function GET(request: Request) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    return NextResponse.json(await adminBoard(sql, userId, role));
  } catch (error) {
    return fail(error);
  }
}
