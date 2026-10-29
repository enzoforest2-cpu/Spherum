import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/core/projects";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/projects?agency_id=  projetos da agência com progresso e atraso. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "projetos" });
    return NextResponse.json({ projects: await listProjects(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/projects  { agency_id, name, client_id?, owner_user?, priority, tags, start_date?, due_date, playbook?, description? } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
    return NextResponse.json({ project: await createProject(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
