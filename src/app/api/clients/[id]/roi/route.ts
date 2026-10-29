import { NextResponse } from "next/server";
import { z } from "zod";
import { clientAgency } from "@/lib/core/http";
import { addSale, importSales, publishRoi, roiReport } from "@/lib/core/roi";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"], roles: typeof CAN_READ) {
  const userId = await requireUser(request);
  const clientId = uuid.parse((await params).id);
  const sql = await serverSql();
  const agencyId = await clientAgency(sql, clientId);
  await requireRole(sql, userId, agencyId, roles, { area: "campanhas" });
  return { userId, clientId, agencyId, sql };
}

/** GET /api/clients/:id/roi?month=YYYY-MM  retorno do mês (padrão: o mês passado). */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const { clientId, agencyId, sql } = await access(request, params, CAN_READ);
    return NextResponse.json(await roiReport(sql, agencyId, clientId, new URL(request.url).searchParams.get("month") ?? undefined));
  } catch (error) {
    return fail(error);
  }
}

const body = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("venda"), sale: z.unknown() }),
  z.object({ acao: z.literal("planilha"), rows: z.array(z.unknown()) }),
  z.object({ acao: z.literal("publicar"), month: z.string().optional() }),
]);

/** POST /api/clients/:id/roi  { acao: venda { sale } | planilha { rows } | publicar { month? } }. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { userId, clientId, agencyId, sql } = await access(request, params, CAN_USE);
    const p = body.parse(await request.json());
    if (p.acao === "venda") return NextResponse.json(await addSale(sql, agencyId, clientId, userId, "manual", p.sale), { status: 201 });
    if (p.acao === "planilha") return NextResponse.json(await importSales(sql, agencyId, clientId, userId, p.rows));
    return NextResponse.json({ update: await publishRoi(sql, agencyId, userId, clientId, p.month) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
