import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { createNote, listMemory } from "@/lib/xodos/memory/team";
import { loadXodo } from "@/lib/xodos/runner";

/** GET /api/xodos/:id/memory?topico=&cliente=&status=&q=&cursor=&limite=  notas, tópicos, medidor do núcleo e ajustes. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_READ);
    return NextResponse.json(await listMemory(sql, xodo, Object.fromEntries(new URL(request.url).searchParams)));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/xodos/:id/memory  { texto, tipo?, topico?, aliases?, cliente_id?, valido_ate?, fixada?, motivo? }  fixar pede owner ou admin. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const body = await request.json();
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    const role = await requireRole(sql, userId, xodo.agency_id, CAN_USE);
    const result = await createNote(sql, xodo, body, { userId, manage: CAN_MANAGE.includes(role) });
    return NextResponse.json(result, { status: result.criada ? 201 : 200 });
  } catch (error) {
    return fail(error);
  }
}
