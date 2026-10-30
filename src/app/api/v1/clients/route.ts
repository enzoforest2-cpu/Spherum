import { NextResponse } from "next/server";
import { apiAuth, apiFail, apiListClients } from "@/lib/core/public-api";
import { serverSql } from "@/lib/xodos/db";

/** GET /api/v1/clients?status=&include_archived=true&limit=&cursor=  (chave com read) */
export async function GET(request: Request) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "read");
    return NextResponse.json(await apiListClients(sql, ctx, new URL(request.url).searchParams));
  } catch (error) {
    return apiFail(error);
  }
}
