import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { fail } from "@/lib/xodos/http";
import { productionDeps, runDueRoutines, sweep } from "@/lib/xodos";

export const maxDuration = 300;

/**
 * GET /api/cron/xodos  com "Authorization: Bearer $CRON_SECRET".
 * Vence pedidos sem resposta, encerra execuções travadas e roda as rotinas vencidas.
 * Chame a cada 15 minutos (ex.: pg_cron + pg_net no Supabase; veja o README).
 */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    const given = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${secret}`;
    if (!secret || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }
    const deps = await productionDeps();
    const cleanup = await sweep(deps);
    const routines = await runDueRoutines(deps);
    return NextResponse.json({ cleanup, routines });
  } catch (error) {
    return fail(error);
  }
}
