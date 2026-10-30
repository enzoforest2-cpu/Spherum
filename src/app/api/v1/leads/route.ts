import { NextResponse } from "next/server";
import { apiAuth, apiCreateLeads, apiFail, apiListLeads } from "@/lib/core/public-api";
import { serverSql } from "@/lib/xodos/db";

/** GET /api/v1/leads?stage=&list=&limit=&cursor=  leads da prospecção (chave com read) */
export async function GET(request: Request) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "read");
    return NextResponse.json(await apiListLeads(sql, ctx, new URL(request.url).searchParams));
  } catch (error) {
    return apiFail(error);
  }
}

/** POST /api/v1/leads  { list, consent: true, leads: [{ phone, name?, company?, … }] }  (chave com write; até 100 por pedido) */
export async function POST(request: Request) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "write");
    return NextResponse.json(await apiCreateLeads(sql, ctx, await request.json()), { status: 201 });
  } catch (error) {
    return apiFail(error);
  }
}
