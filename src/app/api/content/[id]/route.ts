import { NextResponse } from "next/server";
import { z } from "zod";
import { addComment, deletePost, markPublished, publishPost, schedulePost, sendForApproval, updatePost } from "@/lib/core/content";
import { contentDeps } from "@/lib/core/content-meta";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 300;

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const row = await one<{ agency_id: string }>(sql, `select agency_id from content_posts where id = $1`, [id]);
  if (!row) throw new XodoError("Post não encontrado.", 404);
  await requireRole(sql, userId, row.agency_id, CAN_USE);
  return { userId, id, agencyId: row.agency_id, sql };
}

const body = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("editar"), post: z.record(z.string(), z.unknown()) }),
  z.object({ acao: z.literal("aprovacao"), note: z.string().trim().max(1000).optional() }),
  z.object({ acao: z.literal("versao"), note: z.string().trim().max(1000).optional() }),
  z.object({ acao: z.literal("comentar"), text: z.string() }),
  z.object({ acao: z.literal("agendar"), publish_at: z.string().optional() }),
  z.object({ acao: z.literal("desagendar") }),
  z.object({ acao: z.literal("publicar") }),
  z.object({ acao: z.literal("publicado"), url: z.string().optional() }),
]);

/**
 * PATCH /api/content/:id  { acao, ... }
 *   editar { post }   aprovacao { note? }  (manda ao portal)   versao { note? }  (nova versão ao cliente)
 *   comentar { text }   agendar { publish_at? }   desagendar   publicar  (agora)   publicado { url? }  (saiu por fora)
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    const p = body.parse(await request.json());
    if (p.acao === "editar") await updatePost(sql, agencyId, userId, id, p.post);
    else if (p.acao === "aprovacao" || p.acao === "versao") await sendForApproval(await contentDeps(sql), agencyId, userId, id, { newVersion: p.acao === "versao", note: p.note });
    else if (p.acao === "comentar") await addComment(sql, agencyId, userId, id, p.text, (await contentDeps(sql)).collab);
    else if (p.acao === "agendar") await schedulePost(sql, agencyId, userId, id, true, p.publish_at);
    else if (p.acao === "desagendar") await schedulePost(sql, agencyId, userId, id, false);
    else if (p.acao === "publicar") return NextResponse.json(await publishPost(await contentDeps(sql), agencyId, id));
    else await markPublished(sql, agencyId, userId, id, p.url);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/content/:id  apaga o post (e cancela o pedido de aprovação aberto). */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params);
    await deletePost(sql, agencyId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
