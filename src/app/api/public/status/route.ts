import { NextResponse } from "next/server";
import { publicStatus } from "@/lib/core/status";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

export const dynamic = "force-dynamic";

/** GET /api/public/status  (público) situação dos serviços e incidentes dos últimos 30 dias, sem dados de agência. */
export async function GET() {
  try {
    return NextResponse.json(await publicStatus(await serverSql()), { headers: { "cache-control": "public, max-age=30, s-maxage=60" } });
  } catch (error) {
    return fail(error);
  }
}
