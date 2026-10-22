import { NextResponse } from "next/server";
import { clientIp } from "@/lib/core/http";
import { acceptProposal } from "@/lib/core/proposals";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

/** POST /api/public/proposals/:token/accept  { name, email, agree: true }  aceite eletrônico (nome, e-mail, data e IP). */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const sql = await serverSql();
    await acceptProposal(sql, (await params).token, await request.json(), clientIp(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
