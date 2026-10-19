import { NextResponse } from "next/server";
import { inviteLink } from "@/lib/core/http";
import { inviteMember, listInvites } from "@/lib/core/team";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agencies/:id/invites  convites em aberto (equipe e portal do cliente). */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json({ invites: await listInvites(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/agencies/:id/invites  { email, role }  devolve o link do convite (vale 7 dias, uma vez). */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    const role = await requireRole(sql, userId, agencyId, CAN_MANAGE);
    const { token, ...invite } = await inviteMember(sql, agencyId, { id: userId, role }, await request.json());
    return NextResponse.json({ invite, link: inviteLink(token, request) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
