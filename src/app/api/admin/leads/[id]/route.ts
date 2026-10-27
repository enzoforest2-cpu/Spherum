import { NextResponse } from "next/server";
import { updateSiteLead } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/admin/leads/:id  { stage?, owner_user?, note? } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    await updateSiteLead(sql, { id: userId, role }, uuid.parse((await params).id), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
