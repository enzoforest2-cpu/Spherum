import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteAutomation, setEnabled, testAutomation, updateAutomation } from "@/lib/core/automations";
import { automationDeps } from "@/lib/core/automations-deps";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const row = await one<{ agency_id: string }>(sql, `select agency_id from automations where id = $1`, [id]);
  if (!row) throw new XodoError("Automação não encontrada.", 404);
  await requireRole(sql, userId, row.agency_id, CAN_USE, { area: "projetos" });
  return { id, agencyId: row.agency_id, sql };
}

const body = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("editar"), automation: z.record(z.string(), z.unknown()) }),
  z.object({ acao: z.literal("ligar"), on: z.boolean() }),
  z.object({ acao: z.literal("testar") }),
]);

/** PATCH /api/automations/:id  { acao: editar { automation } | ligar { on } | testar }  (testar não envia nada). */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params);
    const p = body.parse(await request.json());
    if (p.acao === "editar") await updateAutomation(sql, agencyId, id, p.automation);
    else if (p.acao === "ligar") await setEnabled(sql, agencyId, id, p.on);
    else return NextResponse.json(await testAutomation(await automationDeps(sql), agencyId, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/automations/:id */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params);
    await deleteAutomation(sql, agencyId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
