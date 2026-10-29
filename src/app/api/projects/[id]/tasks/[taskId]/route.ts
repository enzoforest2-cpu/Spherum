import { NextResponse } from "next/server";
import { projectAgency } from "@/lib/core/http";
import { deleteTask, updateTask } from "@/lib/core/projects";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const p = await params;
  const id = uuid.parse(p.id), taskId = uuid.parse(p.taskId);
  const sql = await serverSql();
  const agencyId = await projectAgency(sql, id);
  await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
  return { userId, id, taskId, agencyId, sql };
}

/** PATCH /api/projects/:id/tasks/:taskId  { done?, title?, assignee_user?, due_date?, position? } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { userId, id, taskId, agencyId, sql } = await access(request, params);
    await updateTask(sql, agencyId, userId, id, taskId, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { id, taskId, agencyId, sql } = await access(request, params);
    await deleteTask(sql, agencyId, id, taskId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
