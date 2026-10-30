import { NextResponse } from "next/server";
import { adminDeps } from "@/lib/core/admin-deps";
import { deleteAnnouncement, sendAnnouncement, staffCan } from "@/lib/core/admin";
import { requireAdmin } from "@/lib/core/http";
import { fail, uuid } from "@/lib/xodos/http";

/** POST /api/admin/comms/:id  envia agora um rascunho ou agendado  ·  DELETE apaga (se não foi enviado). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { role, sql } = await requireAdmin(request);
    staffCan(role, "comms");
    return NextResponse.json(await sendAnnouncement(adminDeps(sql), uuid.parse((await params).id)));
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId, role, sql } = await requireAdmin(request);
    await deleteAnnouncement(sql, { id: userId, role }, uuid.parse((await params).id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
