import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { handleSpherumWebhook, subDepsFromEnv } from "@/lib/core/subscription";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

/** POST /api/spherum/asaas  aviso de pagamento da conta Asaas do Spherum (token em asaas-access-token). */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const sql = await serverSql();
    return NextResponse.json(await handleSpherumWebhook(subDepsFromEnv(sql, mailerFromEnv()), request.headers.get("asaas-access-token"), body));
  } catch (error) {
    return fail(error);
  }
}
