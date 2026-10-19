import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { deleteTopic, updateTopic } from "@/lib/xodos/memory/team";
import { loadXodo } from "@/lib/xodos/runner";

type Params = { params: Promise<{ id: string; slug: string }> };

/** PUT /api/xodos/:id/memory/topics/:slug  { titulo?, descricao?, aliases? }  os apelidos enviados substituem os de antes. */
export async function PUT(request: Request, { params }: Params) {
  try {
    const userId = await requireUser(request);
    const { id, slug } = await params;
    const xodoId = uuid.parse(id);
    const body = await request.json();
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    const role = await requireRole(sql, userId, xodo.agency_id, CAN_USE);
    return NextResponse.json(await updateTopic(sql, xodo, slug, body, { userId, manage: CAN_MANAGE.includes(role) }));
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/xodos/:id/memory/topics/:slug?motivo=  arquiva as notas do tópico num lote só (dá para desfazer). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const userId = await requireUser(request);
    const { id, slug } = await params;
    const xodoId = uuid.parse(id);
    const reason = new URL(request.url).searchParams.get("motivo")?.slice(0, 200) ?? null;
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    const role = await requireRole(sql, userId, xodo.agency_id, CAN_USE);
    return NextResponse.json(await deleteTopic(sql, xodo, slug, { userId, manage: CAN_MANAGE.includes(role) }, reason));
  } catch (error) {
    return fail(error);
  }
}
