import { NextResponse } from "next/server";
import { z } from "zod";
import { clientAccess } from "@/lib/core/client-portal";
import { answerRequest, decideApproval, markRead, sendMessage } from "@/lib/core/collab";
import { documentsStorage, finishUpload, startUpload } from "@/lib/core/documents";
import { answerNps } from "@/lib/core/risk";
import { addSale } from "@/lib/core/roi";
import { openTicket, replyTicket } from "@/lib/core/tickets";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

const body = z.object({
  client_id: uuid,
  tipo: z.enum(["pendencia", "aprovacao", "mensagem", "lido", "arquivo", "arquivo_pronto", "chamado", "chamado_resposta", "nps", "venda"]),
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
 *   chamado { subject, text, priority? }               abre um chamado para a agência
 *   chamado_resposta { item_id, text }                 responde (ou reabre) um chamado
 *   nps { score, comment? }                            responde a pesquisa de NPS
 *   venda { sold_on, amount, customer?, campaign_id?, lead_on? }  marca uma venda (entra no Retorno)
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
      case "chamado": {
        const priority = rest.priority === "alta" || rest.priority === "baixa" ? rest.priority : "media";
        return NextResponse.json(await openTicket(sql, access.agencyId, userId, "cliente", { client_id: p.client_id, subject: rest.subject, text: rest.text, priority }), { status: 201 });
      }
      case "nps":
        await answerNps(sql, access.agencyId, p.client_id, userId, rest);
        return NextResponse.json({ ok: true });
      case "venda": {
        // O cliente não escolhe o código externo (é da importação da agência).
        delete rest.external_id;
        return NextResponse.json(await addSale(sql, access.agencyId, p.client_id, userId, "portal", rest), { status: 201 });
      }
      case "chamado_resposta": {
        const id = uuid.parse(p.item_id);
        const mine = await one(sql, `select 1 from tickets where id = $1 and client_id = $2`, [id, p.client_id]);
        if (!mine) throw new XodoError("Chamado não encontrado.", 404);
        await replyTicket({ sql }, access.agencyId, userId, "cliente", id, String(rest.text ?? ""));
        return NextResponse.json({ ok: true });
      }
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
