import { NextResponse } from "next/server";
import { checkDomain, domainOf, removeDomain, setDomain, vercelEnv } from "@/lib/core/brand";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Domínio próprio do portal do cliente (a partir do Escala).
 * GET     o domínio cadastrado, a situação e os registros de DNS a criar
 * PUT     { domain }  cadastra (ou troca) o domínio
 * POST    confere de novo na Vercel se o DNS já está certo
 * DELETE  tira o domínio
 */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "configuracoes" });
    return NextResponse.json({ domain: await domainOf(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json({ domain: await setDomain(sql, fetch, vercelEnv(), agencyId, userId, await request.json()) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json({ domain: await checkDomain(sql, fetch, vercelEnv(), agencyId) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse((await params).id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "configuracoes" });
    return NextResponse.json(await removeDomain(sql, fetch, vercelEnv(), agencyId, userId));
  } catch (error) {
    return fail(error);
  }
}
