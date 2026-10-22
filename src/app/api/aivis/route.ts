import { NextResponse } from "next/server";
import { z } from "zod";
import { addQuery, aivisBoard, runChecks, setClientSettings, tipToTask } from "@/lib/core/aivis";
import { aivisDeps } from "@/lib/core/aivis-llm";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

export const maxDuration = 300;

/** GET /api/aivis?agency_id=&client_id=  perguntas × modelos, participação nas menções e dicas. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const q = new URL(request.url).searchParams;
    const agencyId = uuid.parse(q.get("agency_id")), clientId = uuid.parse(q.get("client_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    const deps = aivisDeps(sql);
    return NextResponse.json(await aivisBoard(sql, agencyId, clientId, await deps.engines(agencyId)));
  } catch (error) {
    return fail(error);
  }
}

const body = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("pergunta"), question: z.string() }),
  z.object({ acao: z.literal("checar"), only_new: z.boolean().optional() }),
  z.object({ acao: z.literal("config"), aliases: z.array(z.string()).optional(), competitors: z.array(z.string()).optional(), published: z.boolean().optional() }),
  z.object({ acao: z.literal("tarefa"), title: z.string(), assignee_user: z.string().nullable().optional(), due_date: z.string() }),
]);

/**
 * POST /api/aivis  { agency_id, client_id, acao, ... }
 *   pergunta { question }   checar { only_new? }  (pergunta aos modelos agora)   config { aliases?, competitors?, published? }   tarefa { title, assignee_user?, due_date }
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const raw = await request.json();
    const agencyId = uuid.parse(raw.agency_id), clientId = uuid.parse(raw.client_id);
    const p = body.parse(raw);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    if (p.acao === "pergunta") {
      const q = await addQuery(sql, agencyId, userId, clientId, p.question);
      // A primeira checagem da pergunta nova sai na hora.
      const r = await runChecks(aivisDeps(sql), agencyId, clientId, { onlyNew: true }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      return NextResponse.json({ query: q, check: r }, { status: 201 });
    }
    if (p.acao === "checar") return NextResponse.json(await runChecks(aivisDeps(sql), agencyId, clientId, { onlyNew: p.only_new }));
    if (p.acao === "config") { await setClientSettings(sql, agencyId, clientId, p); return NextResponse.json({ ok: true }); }
    return NextResponse.json({ task: await tipToTask(sql, agencyId, userId, clientId, p) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
