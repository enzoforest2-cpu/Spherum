import { NextResponse } from "next/server";
import { projectAgency } from "@/lib/core/http";
import { deleteProject, updateProject } from "@/lib/core/projects";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const agencyId = await projectAgency(sql, id);
  await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
  return { userId, id, agencyId, sql };
}

/** PATCH /api/projects/:id  { name?, status?, priority?, owner_user?, client_id?, start_date?, due_date?, progress?, tags?, description? } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    await updateProject(sql, agencyId, userId, id, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/projects/:id  apaga o projeto e as tarefas dele. */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    await deleteProject(sql, agencyId, userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
