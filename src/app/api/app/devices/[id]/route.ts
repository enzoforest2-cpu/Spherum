import { NextResponse } from "next/server";
import { removeDevice } from "@/lib/core/push";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/app/devices/:id  desconecta um aparelho seu. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    await removeDevice(await serverSql(), userId, uuid.parse((await params).id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
