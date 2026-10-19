import { NextResponse } from "next/server";
import { z } from "zod";
import { acceptInvite } from "@/lib/core/team";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireAuth } from "@/lib/xodos/http";

/** POST /api/invites/accept  { token }  aceita com a conta logada (precisa ser o e-mail convidado). */
export async function POST(request: Request) {
  try {
    const user = await requireAuth(request);
    const { token } = z.object({ token: z.string().min(1).max(100) }).parse(await request.json());
    return NextResponse.json(await acceptInvite(await serverSql(), user, token));
  } catch (error) {
    return fail(error);
  }
}
