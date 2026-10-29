import { NextResponse } from "next/server";
import { z } from "zod";
import { badgeBoard, giveKudos, setConfig } from "@/lib/core/badges";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/badges?agency_id=&period=week|month  ranking, emblemas, regras, desafio e reconhecimentos. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const q = new URL(request.url).searchParams;
    const agencyId = uuid.parse(q.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "equipe" });
    return NextResponse.json(await badgeBoard(sql, agencyId, userId, q.get("period") === "week" ? "week" : "month"));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/badges  { agency_id, to_user, text }  reconhecimento a um colega. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "equipe" });
    await giveKudos(sql, agencyId, userId, input);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/badges  { agency_id, points?, show_ranking?, challenge? }  (dono ou admin). */
export async function PATCH(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = z.object({ agency_id: uuid }).passthrough().parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, agency_id, CAN_MANAGE, { area: "equipe" });
    return NextResponse.json({ config: await setConfig(sql, agency_id, input) });
  } catch (error) {
    return fail(error);
  }
}
