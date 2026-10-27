import { NextResponse } from "next/server";
import { adminDeps } from "@/lib/core/admin-deps";
import { messageAgency, updateAgencyAdmin } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

/**
 * PATCH /api/admin/agencies/:id  { plan?, plan_status?, trial_days?, suspend?: { reason }, reactivate? }
 * POST  /api/admin/agencies/:id  { subject, body }  mensagem para a agência (aviso no app e e-mail).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    await updateAgencyAdmin(sql, { id: userId, role }, uuid.parse((await params).id), await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    const role = await requireStaff(sql, userId);
    return NextResponse.json(await messageAgency(adminDeps(sql), { id: userId, role }, uuid.parse((await params).id), await request.json()));
  } catch (error) {
    return fail(error);
  }
}
