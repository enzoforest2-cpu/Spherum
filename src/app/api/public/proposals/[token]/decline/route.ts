import { NextResponse } from "next/server";
import { z } from "zod";
import { declineProposal } from "@/lib/core/proposals";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

/** POST /api/public/proposals/:token/decline  { reason? }  o cliente recusa (a agência é avisada). */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(await request.json());
    const sql = await serverSql();
    await declineProposal(sql, (await params).token, reason);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
