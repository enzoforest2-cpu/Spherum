import { after, NextResponse } from "next/server";
import { z } from "zod";
import { channelAgency } from "@/lib/core/http";
import { listMessages, mentionedXodos, postMessage } from "@/lib/core/team-chat";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { continueRun, productionDeps, startRun } from "@/lib/xodos";

export const maxDuration = 300;

/** GET /api/team-chat/:id/messages  últimas 200 mensagens; marca o canal como lido (?read=0 não marca). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await channelAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_READ);
    const read = new URL(request.url).searchParams.get("read") !== "0";
    return NextResponse.json({ messages: await listMessages(sql, agencyId, userId, id, read) });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/team-chat/:id/messages  { text }  publica; cada @xodó citado recebe o pedido e trabalha em segundo plano. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const id = uuid.parse((await params).id);
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(await request.json());
    const sql = await serverSql();
    const agencyId = await channelAgency(sql, id);
    await requireRole(sql, userId, agencyId, CAN_USE);
    // Citar um xodó dá trabalho a ele: pede o mesmo acesso de conversar com ele em Xodós.
    const xodos = await mentionedXodos(sql, agencyId, text);
    if (xodos.length) await requireRole(sql, userId, agencyId, CAN_USE, { area: "xodos" });
    const message = await postMessage(sql, agencyId, userId, id, text);
    const runs: string[] = [];
    if (xodos.length) {
      const deps = await productionDeps();
      for (const x of xodos) {
        const runId = await startRun(deps, { xodoId: x.id, agencyId, trigger: "user", text, userId });
        runs.push(runId);
        after(() => continueRun(deps, runId).catch((error) => console.error("[team-chat] execução falhou", runId, error)));
        await postMessage(sql, agencyId, userId, id, `Pedido entregue a ${x.name}. A resposta aparece na conversa dele em Xodós.`, true);
      }
    }
    return NextResponse.json({ message, runs }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
