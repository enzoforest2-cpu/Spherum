import { NextResponse } from "next/server";
import { z } from "zod";
import { clientAccess } from "@/lib/core/client-portal";
import { answerRequest, decideApproval, markRead, sendMessage } from "@/lib/core/collab";
import { documentsStorage, finishUpload, startUpload } from "@/lib/core/documents";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

const body = z.object({
  client_id: uuid,
  tipo: z.enum(["pendencia", "aprovacao", "mensagem", "lido", "arquivo", "arquivo_pronto"]),
  item_id: z.uuid().optional(),
}).passthrough();

/**
 * POST /api/portal/cliente/collab  { client_id, tipo, ... }  o lado do cliente:
 *   pendencia { item_id, response?, document_id? }   resolve uma pendência
 *   aprovacao { item_id, decision, comment? }         aprova ou pede ajustes
 *   mensagem { text }                                  escreve para a agência
 *   lido                                               marca a conversa como lida
 *   arquivo { name, size, mime }                       começa o envio de um arquivo (devolve a URL de upload)
 *   arquivo_pronto { item_id }                         confirma o arquivo enviado
 */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const raw = await request.json();
    const p = body.parse(raw);
    const sql = await serverSql();
    const access = await clientAccess(sql, userId, p.client_id);
    // Só quem é do cliente fala pelo lado do cliente (a equipe usa as rotas da agência).
    if (access.as !== "cliente") throw new XodoError("Use a tela da agência para isso.", 403);
    const rest = { ...(raw as Record<string, unknown>) };
    delete rest.client_id;
    delete rest.tipo;
    delete rest.item_id;
    switch (p.tipo) {
      case "pendencia":
        await answerRequest(sql, userId, uuid.parse(p.item_id), rest);
        return NextResponse.json({ ok: true });
      case "aprovacao":
        await decideApproval(sql, userId, uuid.parse(p.item_id), rest);
        return NextResponse.json({ ok: true });
      case "mensagem":
        return NextResponse.json(await sendMessage({ sql, appUrl: process.env.APP_URL }, "cliente", access.agencyId, p.client_id, userId, rest), { status: 201 });
      case "lido":
        await markRead(sql, p.client_id, "cliente");
        return NextResponse.json({ ok: true });
      case "arquivo":
        return NextResponse.json(
          await startUpload(sql, documentsStorage(), access.agencyId, userId, { ...rest, client_id: p.client_id, category: "Outros", shared: true }),
          { status: 201 },
        );
      case "arquivo_pronto": {
        const id = uuid.parse(p.item_id);
        const mine = await one(sql, `select 1 from documents where id = $1 and client_id = $2 and uploaded_by = $3`, [id, p.client_id, userId]);
        if (!mine) throw new XodoError("Arquivo não encontrado.", 404);
        return NextResponse.json({ document: await finishUpload(sql, documentsStorage(), access.agencyId, userId, id) });
      }
    }
  } catch (error) {
    return fail(error);
  }
}
