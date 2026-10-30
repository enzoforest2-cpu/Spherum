import { NextResponse } from "next/server";
import { adminDeps } from "@/lib/core/admin-deps";
import { replySupport, setSupportStatus } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail, uuid } from "@/lib/xodos/http";

/** POST /api/admin/support/:id  { text }  responde  ·  PATCH { status: open|done } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    await replySupport(adminDeps(sql), { id: userId, role }, uuid.parse((await params).id), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    await setSupportStatus(sql, { id: userId, role }, uuid.parse((await params).id), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
