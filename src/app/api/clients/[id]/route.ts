import { NextResponse } from "next/server";
import { getClient, setClientArchived, updateClient } from "@/lib/core/clients";
import { clientAgency } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/clients/:id  cliente com contatos. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_READ, { area: "clientes" });
    return NextResponse.json({ client: await getClient(sql, agencyId, clientId) });
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/clients/:id  campos do cliente; { archived: true|false } arquiva ou reativa (owner e admin). */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    const { archived, ...fields } = (await request.json()) ?? {};
    if (typeof archived === "boolean") {
      await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "clientes" });
      await setClientArchived(sql, agencyId, userId, clientId, archived);
    } else {
      await requireRole(sql, userId, agencyId, CAN_USE, { area: "clientes" });
    }
    return NextResponse.json({ client: await updateClient(sql, agencyId, userId, clientId, fields) });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE /api/clients/:id  arquiva (os dados ficam; dá para reativar). */
export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "clientes" });
    return NextResponse.json({ client: await setClientArchived(sql, agencyId, userId, clientId, true) });
  } catch (error) {
    return fail(error);
  }
}
