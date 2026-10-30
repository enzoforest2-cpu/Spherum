import { NextResponse } from "next/server";
import { createManualLead } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail } from "@/lib/xodos/http";

/** POST /api/admin/leads  { company, name, email, phone?, clients?, plan?, note? }  lead que chegou por fora do site. */
export async function POST(request: Request) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    return NextResponse.json(await createManualLead(sql, { id: userId, role }, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
