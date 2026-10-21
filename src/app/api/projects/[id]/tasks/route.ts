import { NextResponse } from "next/server";
import { projectAgency } from "@/lib/core/http";
import { addTask, listTasks } from "@/lib/core/projects";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/projects/:id/tasks  as tarefas do projeto, na ordem. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await projectAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ tasks: await listTasks(sql, agencyId, id) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/projects/:id/tasks  { title, assignee_user?, due_date? } */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await projectAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ task: await addTask(sql, agencyId, id, await request.json()) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
