import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelNotice, endContract, noticeContract, pauseContract, renewContract, resumeContract, updateContract } from "@/lib/core/contracts";
import { contractAgency } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

const body = z.object({ acao: z.enum(["renovar", "pausar", "retomar", "aviso", "cancelar_aviso", "encerrar", "editar"]) }).passthrough();

/**
 * PATCH /api/contracts/:id  { acao, ... }
 *   renovar { end_date, adjust_percent }   pausar { from, to, reason, billing: suspender | metade | manter }
 *   retomar   aviso { notice_end, reason? }   cancelar_aviso   encerrar   editar { monthly_fee?, document_id?, notes? }
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const raw = await request.json();
    const { acao } = body.parse(raw);
    const sql = await serverSql();
    const agencyId = await contractAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_BILL);
    const rest = { ...(raw as Record<string, unknown>) };
    delete rest.acao;
    if (acao === "renovar") return NextResponse.json(await renewContract(sql, agencyId, userId, id, rest));
    if (acao === "pausar") await pauseContract(sql, agencyId, userId, id, rest);
    else if (acao === "retomar") await resumeContract(sql, agencyId, userId, id);
    else if (acao === "aviso") await noticeContract(sql, agencyId, userId, id, rest);
    else if (acao === "cancelar_aviso") await cancelNotice(sql, agencyId, userId, id);
    else if (acao === "encerrar") await endContract(sql, agencyId, userId, id);
    else await updateContract(sql, agencyId, userId, id, rest);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
