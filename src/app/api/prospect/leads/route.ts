import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteLeads, importLeads, queueLeads } from "@/lib/core/prospect";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/**
 * POST /api/prospect/leads  { agency_id, list, source?, rows? | text?, consent: true, dry_run? }
 * importa a lista (telefones conferidos, repetidos e bloqueados ficam de fora).
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, dry_run, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
    return NextResponse.json(await importLeads(sql, agencyId, userId, input, dry_run === true), { status: dry_run ? 200 : 201 });
  } catch (error) {
    return fail(error);
  }
}

const bulk = z.object({ agency_id: uuid, ids: z.array(uuid).min(1).max(5000), acao: z.enum(["fila", "excluir"]) });

/** PATCH /api/prospect/leads  { agency_id, ids, acao: fila | excluir }  põe na cadência ou apaga. */
export async function PATCH(request: Request) {
  try {
    const userId = await requireUser(request);
    const p = bulk.parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, p.agency_id, CAN_USE, { area: "comercial" });
    return NextResponse.json(p.acao === "fila" ? await queueLeads(sql, p.agency_id, p.ids) : await deleteLeads(sql, p.agency_id, p.ids));
  } catch (error) {
    return fail(error);
  }
}
