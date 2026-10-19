import { NextResponse } from "next/server";
import { previewInvite } from "@/lib/core/team";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

/** GET /api/invites/:token  prévia pública do convite (agência, papel e o e-mail com o meio escondido). */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    return NextResponse.json({ invite: await previewInvite(await serverSql(), (await params).token) });
  } catch (error) {
    return fail(error);
  }
}
