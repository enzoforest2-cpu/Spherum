import { NextResponse } from "next/server";
import { z } from "zod";
import { winDeal } from "@/lib/core/crm";
import { inviteEmail, mailerFromEnv } from "@/lib/core/email";
import { dealAgency, inviteLink } from "@/lib/core/http";
import { inviteClientUser } from "@/lib/core/team";
import { one, serverSql } from "@/lib/xodos/db";
import { CAN_BILL, CAN_MANAGE, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/**
 * POST /api/deals/:id/win  { contract?, billing_day?, onboarding?, invite? }
 * Negócio fechado vira cliente. O contrato (com a mensalidade) só sai para quem cobra (dono, admin,
 * financeiro); o convite para o portal, para dono e admin, e só se o negócio tiver e-mail.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const raw = await request.json();
    const { invite, ...rest } = z.object({ invite: z.boolean().default(true) }).passthrough().parse(raw);
    const sql = await serverSql();
    const agencyId = await dealAgency(sql, id);
    const role = await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
    const canBill = CAN_BILL.includes(role);
    const result = await winDeal(sql, agencyId, userId, id, { ...rest, contract: canBill && rest.contract !== false });
    let invited: { email: string; emailed: boolean; link: string } | null = null;
    if (invite && result.email && CAN_MANAGE.includes(role)) {
      const { token, ...inv } = await inviteClientUser(sql, agencyId, result.client_id, userId, { email: result.email });
      const link = inviteLink(token, request);
      const names = await one<{ agency: string; client: string }>(sql, `select a.name as agency, c.name as client from clients c join agencies a on a.id = c.agency_id where c.id = $1`, [result.client_id]);
      const emailed = await mailerFromEnv()(inviteEmail({ to: inv.email, agency: names?.agency ?? "agência", client: names?.client, link }));
      invited = { email: inv.email, emailed, link };
    }
    return NextResponse.json({ ...result, contract_skipped: !canBill, invited }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
