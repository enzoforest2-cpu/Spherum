import { NextResponse } from "next/server";
import { z } from "zod";
import { dealAgency } from "@/lib/core/http";
import { setDealFlags } from "@/lib/core/scoring";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** PATCH /api/deals/:id/score  { flags: [chaves dos critérios manuais que o negócio atende] } */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { flags } = z.object({ flags: z.array(z.string()) }).parse(await request.json());
    const sql = await serverSql();
    const agencyId = await dealAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE);
    await setDealFlags(sql, agencyId, id, flags);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
