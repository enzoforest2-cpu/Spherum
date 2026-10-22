import { NextResponse } from "next/server";
import { viewProposal } from "@/lib/core/proposals";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

/** GET /api/public/proposals/:token  a proposta como o cliente vê (sem login). Conta a visualização. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const sql = await serverSql();
    return NextResponse.json(await viewProposal(sql, (await params).token));
  } catch (error) {
    return fail(error);
  }
}
