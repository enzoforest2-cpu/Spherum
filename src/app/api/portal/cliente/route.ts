import { NextResponse } from "next/server";
import { clientPortal } from "@/lib/core/client-portal";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser, uuid } from "@/lib/xodos/http";

/** GET /api/portal/cliente?client_id=…  o que o portal do cliente mostra (para o cliente ou para a agência conferir). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const clientId = uuid.parse(new URL(request.url).searchParams.get("client_id"));
    return NextResponse.json(await clientPortal(await serverSql(), clientId, userId));
  } catch (error) {
    return fail(error);
  }
}
