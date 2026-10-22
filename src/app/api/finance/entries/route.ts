import { NextResponse } from "next/server";
import { addEntry, dreReport } from "@/lib/core/dre";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/finance/entries?agency_id=&months=  DRE dos últimos meses (padrão 3, até 12). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const q = new URL(request.url).searchParams;
    const agencyId = uuid.parse(q.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    return NextResponse.json(await dreReport(sql, agencyId, Math.min(12, Math.max(1, Number(q.get("months")) || 3))));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/finance/entries  { agency_id, kind: fixa | variavel | receita, category, description, amount, month: AAAA-MM, recurring?, client_id? } */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    return NextResponse.json({ entry: await addEntry(sql, agencyId, userId, input) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
