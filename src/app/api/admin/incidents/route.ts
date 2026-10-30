import { NextResponse } from "next/server";
import { createIncident } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail } from "@/lib/xodos/http";

/** POST /api/admin/incidents  { service, title, severity?, text } */
export async function POST(request: Request) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    return NextResponse.json(await createIncident(sql, { id: userId, role }, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
