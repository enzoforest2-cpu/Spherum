import { NextResponse } from "next/server";
import { listConversations, listXodoChannels, removeXodoChannel, setXodoChannel } from "@/lib/channels/manage";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { loadXodo } from "@/lib/xodos/runner";

/** GET /api/xodos/:id/channels  canais em que o xodó atende e as conversas abertas por lá. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_READ, { area: "xodos" });
    const [channels, conversations] = await Promise.all([
      listXodoChannels(sql, xodo.agency_id, xodoId),
      listConversations(sql, xodo.agency_id, xodoId),
    ]);
    return NextResponse.json({ channels, conversations });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/xodos/:id/channels  { connection_id, scope?, enabled? }  o xodó passa a atender naquele canal. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE, { area: "xodos" });
    return NextResponse.json({ id: await setXodoChannel(sql, xodo.agency_id, xodoId, await request.json()) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/xodos/:id/channels?channel_id=…  o xodó deixa de atender naquele canal. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const channelId = uuid.parse(new URL(request.url).searchParams.get("channel_id"));
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE, { area: "xodos" });
    await removeXodoChannel(sql, xodo.agency_id, xodoId, channelId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
