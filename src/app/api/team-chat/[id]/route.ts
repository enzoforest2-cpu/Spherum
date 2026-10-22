import { NextResponse } from "next/server";
import { z } from "zod";
import { channelAgency } from "@/lib/core/http";
import { setPin } from "@/lib/core/team-chat";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/team-chat/:id  { pinned_text }  fixa (ou solta, com null) a mensagem do canal. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { pinned_text } = z.object({ pinned_text: z.string().max(4000).nullable() }).parse(await request.json());
    const sql = await serverSql();
    const agencyId = await channelAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE);
    await setPin(sql, agencyId, userId, id, pinned_text);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
