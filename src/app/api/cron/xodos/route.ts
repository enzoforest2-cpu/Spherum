import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { fail } from "@/lib/xodos/http";
import { productionDeps, refreshFx, runDueRoutines, sweep } from "@/lib/xodos";

export const maxDuration = 300;

/**
 * GET /api/cron/xodos  com "Authorization: Bearer $CRON_SECRET".
 * Atualiza a cotação do dólar, vence pedidos sem resposta, encerra execuções travadas e
 * roda as rotinas vencidas.
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
    // Cotação falhando não impede o resto: o gasto usa a última conhecida.
    const fx = await refreshFx(deps.sql, new Date()).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    const cleanup = await sweep(deps);
    const routines = await runDueRoutines(deps);
    return NextResponse.json({ fx, cleanup, routines });
  } catch (error) {
    return fail(error);
  }
}
