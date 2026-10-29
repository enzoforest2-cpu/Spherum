import { NextResponse } from "next/server";
import { z } from "zod";
import { assignTrail, deleteItem, processToProject, remindOnboarding, toggleStep, unassignTrail, updateItem } from "@/lib/core/academy";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const row = await one<{ agency_id: string }>(sql, `select agency_id from academy_items where id = $1`, [id]);
  if (!row) throw new XodoError("Item não encontrado.", 404);
  await requireRole(sql, userId, row.agency_id, CAN_USE, { area: "equipe" });
  return { userId, id, agencyId: row.agency_id, sql };
}

const body = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("editar"), item: z.record(z.string(), z.unknown()) }),
  z.object({ acao: z.literal("passo"), step_id: z.string(), done: z.boolean() }),
  z.object({ acao: z.literal("atribuir"), user_id: uuid, due_date: z.string().nullable().optional() }),
  z.object({ acao: z.literal("desatribuir"), user_id: uuid }),
  z.object({ acao: z.literal("checklist"), client_id: z.string().nullable().optional(), due_date: z.string(), owner_user: z.string().nullable().optional() }),
  z.object({ acao: z.literal("lembrete") }),
]);

/**
 * PATCH /api/academy/:id  { acao, ... }
 *   editar { item }   passo { step_id, done }   atribuir { user_id, due_date? }   desatribuir { user_id }
 *   checklist { client_id?, due_date, owner_user? }  (processo vira projeto)   lembrete  (onboarding)
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    const p = body.parse(await request.json());
    if (p.acao === "editar") await updateItem(sql, agencyId, id, p.item);
    else if (p.acao === "passo") await toggleStep(sql, agencyId, userId, id, p.step_id, p.done);
    else if (p.acao === "atribuir") await assignTrail(sql, agencyId, userId, id, { user_id: p.user_id, due_date: p.due_date });
    else if (p.acao === "desatribuir") await unassignTrail(sql, agencyId, id, p.user_id);
    else if (p.acao === "checklist") return NextResponse.json(await processToProject(sql, agencyId, userId, id, p), { status: 201 });
    else return NextResponse.json(await remindOnboarding(sql, agencyId, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/academy/:id */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params);
    await deleteItem(sql, agencyId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
