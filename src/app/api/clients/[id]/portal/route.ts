import { NextResponse } from "next/server";
import { inviteEmail, mailerFromEnv } from "@/lib/core/email";
import { clientAgency, inviteLink } from "@/lib/core/http";
import { inviteClientUser, listClientUsers, removeClientUser } from "@/lib/core/team";
import { one, serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/clients/:id/portal  quem do cliente entra no portal do cliente. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ users: await listClientUsers(sql, agencyId, clientId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/clients/:id/portal  { email }  convida alguém do cliente por e-mail; devolve o link (7 dias, uma vez). */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    const { token, ...invite } = await inviteClientUser(sql, agencyId, clientId, userId, await request.json());
    const link = inviteLink(token, request);
    const names = await one<{ agency: string; client: string }>(
      sql,
      `select a.name as agency, c.name as client from clients c join agencies a on a.id = c.agency_id where c.id = $1`,
      [clientId],
    );
    const emailed = await mailerFromEnv()(inviteEmail({ to: invite.email, agency: names?.agency ?? "agência", client: names?.client, link }));
    return NextResponse.json({ invite, link, emailed }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/clients/:id/portal?user_id=…  tira o acesso ao portal. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const target = uuid.parse(new URL(request.url).searchParams.get("user_id"));
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    await removeClientUser(sql, agencyId, clientId, userId, target);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
