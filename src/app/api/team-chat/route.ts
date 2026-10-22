import { NextResponse } from "next/server";
import { z } from "zod";
import { chatBoard, createChannel, directChannel } from "@/lib/core/team-chat";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/team-chat?agency_id=  canais, conversas diretas e não lidas de quem pede. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ channels: await chatBoard(sql, agencyId, userId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/team-chat  { agency_id, name, description?, client_id? }  cria um canal; { agency_id, dm_user } abre a conversa direta. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, dm_user, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    const channel = dm_user ? await directChannel(sql, agencyId, userId, z.uuid().parse(dm_user)) : await createChannel(sql, agencyId, userId, input);
    return NextResponse.json({ channel }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
