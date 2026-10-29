import { NextResponse } from "next/server";
import { academyBoard, createItem } from "@/lib/core/academy";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/academy?agency_id=  trilhas (com o seu progresso e quem está fazendo), processos e onboardings. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "equipe" });
    return NextResponse.json({ items: await academyBoard(sql, agencyId, userId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/academy  { agency_id, kind: trilha | processo | onboarding, name, description?, steps?, hire_name?, hire_role?, start_date? }. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "equipe" });
    return NextResponse.json({ item: await createItem(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
