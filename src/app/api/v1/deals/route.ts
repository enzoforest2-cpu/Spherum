import { NextResponse } from "next/server";
import { apiAuth, apiCreateDeal, apiFail, apiListDeals } from "@/lib/core/public-api";
import { serverSql } from "@/lib/xodos/db";

/** GET /api/v1/deals?stage=&limit=&cursor=  negócios do CRM (chave com read) */
export async function GET(request: Request) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "read");
    return NextResponse.json(await apiListDeals(sql, ctx, new URL(request.url).searchParams));
  } catch (error) {
    return apiFail(error);
  }
}

/** POST /api/v1/deals  { company, contact_name?, email?, phone?, value_cents?, stage?, … }  (chave com write) */
export async function POST(request: Request) {
  try {
    const sql = await serverSql();
    const ctx = await apiAuth(sql, request, "write");
    return NextResponse.json(await apiCreateDeal(sql, ctx, await request.json()), { status: 201 });
  } catch (error) {
    return apiFail(error);
  }
}
