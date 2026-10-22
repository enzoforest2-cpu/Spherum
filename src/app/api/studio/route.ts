import { NextResponse } from "next/server";
import { z } from "zod";
import { animate, generate, setKit, studioBoard, toContent } from "@/lib/core/studio";
import { studioDeps } from "@/lib/core/studio-providers";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

export const maxDuration = 300;

/** GET /api/studio?agency_id=&client_id=  kit, conversa (com links das imagens), uso do mês e configuração. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const q = new URL(request.url).searchParams;
    const agencyId = uuid.parse(q.get("agency_id")), clientId = uuid.parse(q.get("client_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await studioBoard(await studioDeps(sql), agencyId, clientId));
  } catch (error) {
    return fail(error);
  }
}

const body = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("gerar"), text: z.string(), format: z.enum(["feed", "story"]).optional(), count: z.number().optional() }),
  z.object({ acao: z.literal("animar"), document_id: uuid, text: z.string() }),
  z.object({ acao: z.literal("conteudo"), document_ids: z.array(uuid), title: z.string(), caption: z.string().optional(), publish_at: z.string(), nets: z.array(z.enum(["IG", "FB"])).optional() }),
  z.object({ acao: z.literal("kit"), kit: z.record(z.string(), z.unknown()) }),
]);

/**
 * POST /api/studio  { agency_id, client_id, acao, ... }
 *   gerar { text, format?, count? }   animar { document_id, text }   conteudo { document_ids, title, caption?, publish_at, nets? }   kit { kit }
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const raw = await request.json();
    const agencyId = uuid.parse(raw.agency_id), clientId = uuid.parse(raw.client_id);
    const p = body.parse(raw);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE);
    if (p.acao === "gerar") return NextResponse.json(await generate(await studioDeps(sql), agencyId, userId, clientId, p), { status: 201 });
    if (p.acao === "animar") { await animate(await studioDeps(sql), agencyId, userId, clientId, p.document_id, p.text); return NextResponse.json({ ok: true }, { status: 202 }); }
    if (p.acao === "conteudo") return NextResponse.json({ post: await toContent(sql, agencyId, userId, clientId, p) }, { status: 201 });
    await setKit(sql, agencyId, clientId, p.kit);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
