import { NextResponse } from "next/server";
import { listMembers } from "@/lib/core/team";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/agencies/:id/members  equipe com papel, nome e e-mail. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "equipe" });
    return NextResponse.json({ members: await listMembers(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}
