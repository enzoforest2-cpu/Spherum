import { NextResponse } from "next/server";
import { billingDepsFromEnv, handleWebhook } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

type Ctx = { params: Promise<{ provider: string; token: string }> };

/**
 * POST /api/billing/webhooks/:provider/:token  aviso do meio de pagamento. O token da URL diz de
 * qual agência é; o status vale só depois de o Spherum perguntar de novo ao provedor.
 */
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { provider, token } = await params;
    const text = await request.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    const sql = await serverSql();
    const result = await handleWebhook(billingDepsFromEnv(sql, masterKeyFromEnv()), provider, token, request.headers, body, new URL(request.url).searchParams);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
