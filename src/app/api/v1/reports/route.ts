import { NextResponse } from "next/server";
import { apiAuth, apiFail, apiListReports } from "@/lib/core/public-api";
import { serverSql } from "@/lib/xodos/db";

/** GET /api/v1/reports?client_id=&limit=&cursor=  relatórios publicados (chave com read) */
export async function GET(request: Request) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "read");
    return NextResponse.json(await apiListReports(sql, ctx, new URL(request.url).searchParams));
  } catch (error) {
    return apiFail(error);
  }
}
