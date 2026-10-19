import { NextResponse } from "next/server";
import { getAgency, updateAgency } from "@/lib/core/agencies";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/agencies/:id  dados da agência. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    const role = await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json({ agency: await getAgency(sql, agencyId), role });
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/agencies/:id  { name?, website?, phone?, city?, state?, cnpj?, brand_color?, timezone? } */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    return NextResponse.json({ agency: await updateAgency(sql, agencyId, userId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}
