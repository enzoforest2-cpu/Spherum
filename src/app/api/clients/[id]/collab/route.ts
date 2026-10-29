import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cancelApproval,
  cancelRequest,
  clientCollab,
  createApproval,
  createRequest,
  createUpdate,
  markRead,
  sendMessage,
  setUpdateStatus,
} from "@/lib/core/collab";
import { mailerFromEnv } from "@/lib/core/email";
import { clientAgency } from "@/lib/core/http";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"], roles: typeof CAN_READ) {
  const userId = await requireUser(request);
  const clientId = uuid.parse((await params).id);
  const sql = await serverSql();
  const agencyId = await clientAgency(sql, clientId);
  await requireRole(sql, userId, agencyId, roles, { area: "clientes" });
  return { userId, clientId, agencyId, sql };
}

/** GET /api/clients/:id/collab[?lido=1]  atualizações, pendências, aprovações e conversa do cliente (visão da agência). */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const { clientId, sql } = await access(request, params, CAN_READ);
    if (new URL(request.url).searchParams.get("lido") === "1") await markRead(sql, clientId, "agencia");
    return NextResponse.json(await clientCollab(sql, clientId, "agencia"));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/clients/:id/collab  { tipo: atualizacao | pendencia | aprovacao | mensagem, ... }  a agência cria. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { userId, clientId, agencyId, sql } = await access(request, params, CAN_USE);
    const { tipo, ...body } = await request.json();
    const deps = { sql, mail: mailerFromEnv(), appUrl: process.env.APP_URL };
    if (tipo === "atualizacao") return NextResponse.json(await createUpdate(sql, agencyId, userId, clientId, body), { status: 201 });
    if (tipo === "pendencia") return NextResponse.json(await createRequest(deps, agencyId, userId, clientId, body), { status: 201 });
    if (tipo === "aprovacao") return NextResponse.json(await createApproval(deps, agencyId, userId, clientId, body), { status: 201 });
    if (tipo === "mensagem") return NextResponse.json(await sendMessage(deps, "agencia", agencyId, clientId, userId, body), { status: 201 });
    throw new XodoError("Tipo desconhecido.", 400);
  } catch (error) {
    return fail(error);
  }
}

const patch = z.object({
  tipo: z.enum(["atualizacao", "pendencia", "aprovacao"]),
  item_id: z.uuid(),
  acao: z.enum(["publicar", "descartar", "rascunho", "cancelar"]),
  title: z.string().trim().max(200).optional(),
  why: z.string().trim().max(600).nullable().optional(),
});

/** PATCH /api/clients/:id/collab  { tipo, item_id, acao }  publicar ou descartar atualização; cancelar pendência ou aprovação. */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { agencyId, clientId, sql } = await access(request, params, CAN_USE);
    const p = patch.parse(await request.json());
    const owned = await one(
      sql,
      `select 1 from ${p.tipo === "atualizacao" ? "client_updates" : p.tipo === "pendencia" ? "client_requests" : "client_approvals"} where id = $1 and client_id = $2`,
      [p.item_id, clientId],
    );
    if (!owned) throw new XodoError("Não encontrado.", 404);
    if (p.tipo === "atualizacao") {
      if (p.acao === "cancelar") throw new XodoError("Ação inválida.", 400);
      await setUpdateStatus(sql, agencyId, p.item_id, p.acao === "publicar" ? "publicado" : p.acao === "descartar" ? "descartado" : "rascunho", { title: p.title, why: p.why });
    } else if (p.acao !== "cancelar") throw new XodoError("Ação inválida.", 400);
    else if (p.tipo === "pendencia") await cancelRequest(sql, agencyId, p.item_id);
    else await cancelApproval(sql, agencyId, p.item_id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
