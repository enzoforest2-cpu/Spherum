import { NextResponse } from "next/server";
import { apiAuth, apiFail, apiGetClient } from "@/lib/core/public-api";
import { serverSql } from "@/lib/xodos/db";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/clients/:id  o cliente com os contatos (chave com read) */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "read");
    return NextResponse.json(await apiGetClient(sql, ctx, (await params).id));
  } catch (error) {
    return apiFail(error);
  }
}
