import { NextResponse } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/core/http";
import { markLeadHandled } from "@/lib/core/leads";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/leads/:id  { handled }  (equipe do Spherum) */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    await requireStaff(sql, userId);
    const { handled } = z.object({ handled: z.boolean() }).parse(await request.json());
    await markLeadHandled(sql, uuid.parse((await params).id), handled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
