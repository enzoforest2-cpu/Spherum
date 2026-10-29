import { NextResponse } from "next/server";
import { z } from "zod";
import { leadMessages, leadToCrm, replyLead, updateLead } from "@/lib/core/prospect";
import { whatsappSender } from "@/lib/core/prospect-wa";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { productionDeps } from "@/lib/xodos";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"], roles: typeof CAN_USE) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const row = await one<{ agency_id: string }>(sql, `select agency_id from prospect_leads where id = $1`, [id]);
  if (!row) throw new XodoError("Lead não encontrado.", 404);
  await requireRole(sql, userId, row.agency_id, roles, { area: "comercial" });
  return { userId, id, agencyId: row.agency_id, sql };
}

/** GET /api/prospect/leads/:id  conversa do lead (marca como lida). */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params, CAN_READ);
    return NextResponse.json({ messages: await leadMessages(sql, agencyId, id) });
  } catch (error) {
    return fail(error);
  }
}

const reply = z.object({ acao: z.literal("responder"), text: z.string() });
const crm = z.object({ acao: z.literal("crm") });

/**
 * PATCH /api/prospect/leads/:id  { acao, ... }
 *   etapa { stage }   dono { owner_user }   nota { text }   parar (bloqueia)
 *   responder { text }  (WhatsApp, dentro das 24 horas)   crm  (vira negócio no CRM)
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params, CAN_USE);
    const raw = await request.json();
    if (reply.safeParse(raw).success) {
      const deps = await productionDeps();
      await replyLead(sql, whatsappSender({ sql: deps.sql, ...deps.integrations! }), agencyId, userId, id, raw.text);
      return NextResponse.json({ ok: true });
    }
    if (crm.safeParse(raw).success) return NextResponse.json({ deal: await leadToCrm(sql, agencyId, userId, id) }, { status: 201 });
    await updateLead(sql, agencyId, userId, id, raw);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
