import { NextResponse } from "next/server";
import { brandForHost } from "@/lib/core/brand";
import { serverSql } from "@/lib/xodos/db";

/** GET /api/public/brand  a marca da agência dona deste domínio (para a tela de entrada no domínio próprio). */
export async function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const brand = await brandForHost(await serverSql(), host).catch(() => null);
  return NextResponse.json({ brand }, { headers: { "cache-control": "public, max-age=300" } });
}
