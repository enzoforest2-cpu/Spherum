import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { conflictBody, deleteNote, editNote, noteNumber } from "@/lib/xodos/memory/team";
import { loadXodo } from "@/lib/xodos/runner";

type Params = { params: Promise<{ id: string; n: string }> };

/** Nota que mudou desde que a tela abriu: 409 com a versão atual em `atual`. */
function failNote(error: unknown) {
  const conflict = conflictBody(error);
  return conflict ? NextResponse.json(conflict, { status: 409 }) : fail(error);
}

/**
 * PATCH /api/xodos/:id/memory/:n  { version, texto?, tipo?, topico?, cliente_id?, valido_ate?, fixada?, status?: "ativo", motivo? }
 * status "ativo" reativa arquivada, vencida ou apagada, ou aceita a proposta da captura. Fixar pede owner ou admin.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const userId = await requireUser(request);
    const { id, n } = await params;
    const xodoId = uuid.parse(id);
    const number = noteNumber.parse(n);
    const body = await request.json();
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    const role = await requireRole(sql, userId, xodo.agency_id, CAN_USE);
    return NextResponse.json(await editNote(sql, xodo, number, body, { userId, manage: CAN_MANAGE.includes(role) }));
  } catch (error) {
    return failNote(error);
  }
}

/** DELETE /api/xodos/:id/memory/:n?version=&motivo=  apaga (dá para desfazer); com definitivo=1, exclui de vez (owner ou admin). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const userId = await requireUser(request);
    const { id, n } = await params;
    const xodoId = uuid.parse(id);
    const number = noteNumber.parse(n);
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const definitivo = query.definitivo === "1" || query.definitivo === "true";
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    const role = await requireRole(sql, userId, xodo.agency_id, definitivo ? CAN_MANAGE : CAN_USE);
    return NextResponse.json(await deleteNote(sql, xodo, number, query, { userId, manage: CAN_MANAGE.includes(role) }));
  } catch (error) {
    return failNote(error);
  }
}
