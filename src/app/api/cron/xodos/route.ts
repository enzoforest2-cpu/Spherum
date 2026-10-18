import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ADAPTERS } from "@/lib/channels";
import { cleanupChannels, flushOutbox } from "@/lib/channels/outbox";
import { pollEmailTriggers } from "@/lib/channels/triggers";
import type { ChannelDeps } from "@/lib/channels/types";
import { fail } from "@/lib/xodos/http";
import { syncDueAccounts } from "@/lib/integrations/ads/sync";
import { warnExpiringConnections } from "@/lib/integrations/store";
import { productionDeps, refreshFx, runDueRoutines, sweep } from "@/lib/xodos";

export const maxDuration = 300;

/**
 * GET /api/cron/xodos  com "Authorization: Bearer $CRON_SECRET".
 * Atualiza a cotação do dólar, sincroniza as métricas das contas de anúncio, avisa logins da
 * Meta perto de vencer, vence pedidos sem resposta, encerra execuções travadas, roda as rotinas,
 * confere os gatilhos de e-mail e entrega o que ficou na fila dos canais.
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
    const integrations = { sql: deps.sql, ...deps.integrations! };
    const ads = await syncDueAccounts(integrations);
    const expiring = await warnExpiringConnections(integrations);
    const cleanup = await sweep(deps);
    const routines = await runDueRoutines(deps);
    const channelDeps = deps as ChannelDeps;
    const email = await pollEmailTriggers(channelDeps);
    // Depois da faxina: pedidos vencidos retomam execuções que avisam pelo canal.
    const delivered = await flushOutbox(channelDeps, ADAPTERS, { limit: 100 });
    const channels = await cleanupChannels(deps.sql, new Date());
    return NextResponse.json({ fx, ads, expiring, cleanup, routines, email, delivered, channels });
  } catch (error) {
    return fail(error);
  }
}
