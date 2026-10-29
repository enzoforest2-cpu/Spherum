import { NextResponse } from "next/server";
import { z } from "zod";
import { mailerFromEnv } from "@/lib/core/email";
import { proposalAgency } from "@/lib/core/http";
import { sendProposal } from "@/lib/core/proposals";
import { one, serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/proposals/:id/send  { valid_days, email? }  gera o link público (um novo a cada envio) e, se pedido, manda por e-mail. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const body = z.object({ valid_days: z.number().int().min(1).max(90).default(15), email: z.boolean().default(true) }).parse(await request.json());
    const sql = await serverSql();
    const agencyId = await proposalAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
    const sent = await sendProposal(sql, agencyId, userId, id, body.valid_days);
    const base = (process.env.APP_URL?.trim() || new URL(request.url).origin).replace(/\/$/, "");
    const link = `${base}/proposta/${sent.token}`;
    let emailed = false;
    if (body.email && sent.email) {
      const agency = await one<{ name: string }>(sql, `select name from agencies where id = $1`, [agencyId]);
      emailed = await mailerFromEnv()({
        to: sent.email,
        subject: `${agency?.name ?? "Agência"}: proposta para ${sent.company}`.slice(0, 200),
        text: `Olá${sent.contact_name ? `, ${sent.contact_name.split(" ")[0]}` : ""}!\n\nA proposta está neste link, válida até ${sent.valid_until.split("-").reverse().join("/")}:\n${link}\n\nPor lá dá para ler tudo e aceitar.`,
      }).catch(() => false);
    }
    return NextResponse.json({ link, valid_until: sent.valid_until, emailed });
  } catch (error) {
    return fail(error);
  }
}
