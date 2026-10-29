import { NextResponse } from "next/server";
import { z } from "zod";
import { contentBoard, createPost, setAutoPublish } from "@/lib/core/content";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/content?agency_id=&from=&to=  posts do período (mais os pendentes), comentários e perfis ligados. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const q = new URL(request.url).searchParams;
    const agencyId = uuid.parse(q.get("agency_id"));
    const day = z.iso.date();
    const now = new Date();
    const from = q.get("from") ? day.parse(q.get("from")) : new Date(now.getTime() - 45 * 864e5).toISOString().slice(0, 10);
    const to = q.get("to") ? day.parse(q.get("to")) : new Date(now.getTime() + 90 * 864e5).toISOString().slice(0, 10);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "projetos" });
    return NextResponse.json(await contentBoard(sql, agencyId, from, to));
  } catch (error) {
    return fail(error);
  }
}

/**
 * POST /api/content  { agency_id, client_id, title, publish_at, caption?, kind?, nets?, media_ids?, schedule? }
 * cria o rascunho; com schedule: true, já entra na fila sem passar pelo cliente.
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, schedule, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
    return NextResponse.json({ post: await createPost(sql, agencyId, userId, input, { schedule: schedule === true }) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/content  { agency_id, auto_publish }  aprovado pelo cliente já entra na fila (dono ou admin). */
export async function PATCH(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, auto_publish } = z.object({ agency_id: uuid, auto_publish: z.boolean() }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, agency_id, CAN_MANAGE, { area: "projetos" });
    await setAutoPublish(sql, agency_id, auto_publish);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
