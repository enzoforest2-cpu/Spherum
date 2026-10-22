import { NextResponse } from "next/server";
import { channelAgency } from "@/lib/core/http";
import { messageToTask } from "@/lib/core/team-chat";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/team-chat/:id/task  { title, assignee_user?, due_date? }  a mensagem vira tarefa em "Combinados da equipe". */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await channelAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ task: await messageToTask(sql, agencyId, userId, await request.json()) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
