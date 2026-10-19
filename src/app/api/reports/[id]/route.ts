import { NextResponse } from "next/server";
import { z } from "zod";
import { setReportStatus } from "@/lib/core/reports";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/reports/:id  { agency_id, status: published | draft | archived } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const body = z.object({ agency_id: uuid, status: z.enum(["published", "draft", "archived"]) }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, body.agency_id, CAN_USE);
    await setReportStatus(sql, body.agency_id, userId, id, body.status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
