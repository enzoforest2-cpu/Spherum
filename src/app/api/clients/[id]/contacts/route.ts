import { NextResponse } from "next/server";
import { addContact } from "@/lib/core/clients";
import { clientAgency } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/clients/:id/contacts  { name, email?, phone?, role?, is_primary? } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse((await params).id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_USE);
    return NextResponse.json({ contact: await addContact(sql, agencyId, clientId, await request.json()) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
