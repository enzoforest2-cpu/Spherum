import { NextResponse } from "next/server";
import { inviteEmail, mailerFromEnv } from "@/lib/core/email";
import { inviteLink } from "@/lib/core/http";
import { inviteMember, listInvites } from "@/lib/core/team";
import { memberAccess } from "@/lib/core/roles";
import { one, serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agencies/:id/invites  convites em aberto (equipe e portal do cliente). */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "equipe" });
    return NextResponse.json({ invites: await listInvites(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/agencies/:id/invites  { email, role }  manda o convite por e-mail e devolve o link (vale 7 dias, uma vez). */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "equipe" });
    const { token, ...invite } = await inviteMember(sql, agencyId, { id: userId, access: (await memberAccess(sql, agencyId, userId))! }, await request.json());
    const link = inviteLink(token, request);
    const agency = await one<{ name: string }>(sql, `select name from agencies where id = $1`, [agencyId]);
    const emailed = await mailerFromEnv()(inviteEmail({ to: invite.email, agency: agency?.name ?? "agência", link }));
    return NextResponse.json({ invite, link, emailed }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
