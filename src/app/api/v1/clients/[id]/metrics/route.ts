import { NextResponse } from "next/server";
import { apiAuth, apiClientMetrics, apiFail } from "@/lib/core/public-api";
import { serverSql } from "@/lib/xodos/db";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/clients/:id/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD  métricas diárias por plataforma (chave com read) */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "read");
    return NextResponse.json(await apiClientMetrics(sql, ctx, (await params).id, new URL(request.url).searchParams));
  } catch (error) {
    return apiFail(error);
  }
}
