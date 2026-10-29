import { NextResponse } from "next/server";
import { deleteForm, updateForm } from "@/lib/core/forms";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const row = await one<{ agency_id: string }>(sql, `select agency_id from forms where id = $1`, [id]);
  if (!row) throw new XodoError("Formulário não encontrado.", 404);
  await requireRole(sql, userId, row.agency_id, CAN_USE, { area: "comercial" });
  return { id, agencyId: row.agency_id, sql };
}

/** PATCH /api/forms/:id  campos, textos, etapa do CRM, responsável, aviso e ativo. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params);
    await updateForm(sql, agencyId, id, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params);
    await deleteForm(sql, agencyId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
