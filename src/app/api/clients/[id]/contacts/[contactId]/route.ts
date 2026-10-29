import { NextResponse } from "next/server";
import { removeContact } from "@/lib/core/clients";
import { clientAgency } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** DELETE /api/clients/:id/contacts/:contactId */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  try {
    const userId = await requireUser(request);
    const p = await params;
    const clientId = uuid.parse(p.id);
    const sql = await serverSql();
    const agencyId = await clientAgency(sql, clientId);
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "clientes" });
    await removeContact(sql, agencyId, clientId, uuid.parse(p.contactId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
