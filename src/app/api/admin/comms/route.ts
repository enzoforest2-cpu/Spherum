import { NextResponse } from "next/server";
import { adminDeps } from "@/lib/core/admin-deps";
import { createAnnouncement } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail } from "@/lib/xodos/http";

/** POST /api/admin/comms  { title, body, channel, segment, cta_label?, cta_url?, send: now|schedule|draft, send_at? } */
export async function POST(request: Request) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    return NextResponse.json(await createAnnouncement(adminDeps(sql), { id: userId, role }, await request.json()), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
