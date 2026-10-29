import { NextResponse } from "next/server";
import { proposalAgency } from "@/lib/core/http";
import { deleteProposal, updateProposal } from "@/lib/core/proposals";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const agencyId = await proposalAgency(sql, id);
  await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
  return { userId, id, agencyId, sql };
}

/** PATCH /api/proposals/:id  campos e doc (o editor salva sozinho). Aceita ou recusada: só o doc (aditivos). */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id, agencyId, sql } = await access(request, params);
    await updateProposal(sql, agencyId, id, await request.json());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    await deleteProposal(sql, agencyId, userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
