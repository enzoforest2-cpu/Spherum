import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { billingDepsFromEnv, billingSweep } from "@/lib/billing";
import { ADAPTERS } from "@/lib/channels";
import { cleanupChannels, flushOutbox } from "@/lib/channels/outbox";
import { pollEmailTriggers } from "@/lib/channels/triggers";
import type { ChannelDeps } from "@/lib/channels/types";
import { computerDeps } from "@/lib/computer";
import { expireControls, withEngine } from "@/lib/computer/control";
import { sweepComputers } from "@/lib/computer/lifecycle";
import { weeklyChecks } from "@/lib/core/aivis";
import { aivisDeps } from "@/lib/core/aivis-llm";
import { automationSweep } from "@/lib/core/automations";
import { automationDeps } from "@/lib/core/automations-deps";
import { publishSweep } from "@/lib/core/content";
import { fiscalSweep } from "@/lib/core/fiscal";
import { fiscalDeps } from "@/lib/core/fiscal-focus";
import { contentDeps } from "@/lib/core/content-meta";
import { prospectSweep } from "@/lib/core/prospect";
import { videoSweep } from "@/lib/core/studio";
import { studioDeps } from "@/lib/core/studio-providers";
import { whatsappSender } from "@/lib/core/prospect-wa";
import { fail } from "@/lib/xodos/http";
import { syncDueAccounts } from "@/lib/integrations/ads/sync";
import { warnExpiringConnections } from "@/lib/integrations/store";
import { productionDeps, refreshFx, runDueRoutines, sweep } from "@/lib/xodos";

export const maxDuration = 300;

/**
 * GET /api/cron/xodos  com "Authorization: Bearer $CRON_SECRET".
 * Atualiza a cotação do dólar, sincroniza as métricas das contas de anúncio, avisa logins da
 * Meta perto de vencer, cuida das faturas (vencidas, mensalidades, conferência), vence pedidos sem resposta, encerra execuções travadas, cuida do computador
 * (controle vencido, máquinas pausadas, sessões longas), roda as rotinas,
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
    const channelDeps = deps as ChannelDeps;
    // Prazo interno abaixo do maxDuration: a fila não começa entregas que não dariam tempo de terminar.
    const deadline = Date.now() + 240_000;
    // Primeiro o que é rápido e pendente desde o último ciclo: entregas dos canais e faxina.
    const channels = await cleanupChannels(deps.sql, new Date());
    const queued = await flushOutbox(channelDeps, ADAPTERS, { limit: 100, deadline });
    // Cotação falhando não impede o resto: o gasto usa a última conhecida.
    const fx = await refreshFx(deps.sql, new Date()).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    const integrations = { sql: deps.sql, ...deps.integrations! };
    const ads = await syncDueAccounts(integrations);
    const expiring = await warnExpiringConnections(integrations);
    // Cobrança: faturas vencidas, mensalidades do mês e conferência das cobranças sem aviso (Itaú).
    const billing = await billingSweep({ ...billingDepsFromEnv(deps.sql, integrations.masterKey) }, { deadline }).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    // Computador antes das retomadas (é rápido e fecha sessões que estão contando custo): dá como
    // pausadas as máquinas vencidas e pausa sessões longas; depois vence o controle de quem passou
    // do prazo (a execução retoma com "expired", até o prazo do cron).
    const machines = { ...withEngine(computerDeps(deps.sql), deps), deadline };
    const swept = await sweepComputers(machines);
    const computers = { controls: await expireControls(machines), ...swept };
    // Retomadas, fatias e rotinas param de começar perto do prazo; o resto fica para o próximo ciclo.
    const cleanup = await sweep(deps, { deadline });
    const routines = Date.now() < deadline - 30_000 ? await runDueRoutines(deps, 5, { deadline }) : [];
    const email = await pollEmailTriggers(channelDeps);
    // Notas fiscais (emissão pela regra da agência e consulta na prefeitura) e régua de cobrança.
    const fiscal = await fiscalSweep(await fiscalDeps(deps.sql), new Date(), { deadline }).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    // Busca por IA: checagem semanal (segunda-feira) das perguntas de cada cliente.
    const aivis = Date.now() < deadline - 60_000 ? await weeklyChecks(aivisDeps(deps.sql), new Date(), { deadline }).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`) : "sem tempo";
    // Estúdio: vídeos que ficaram prontos na fila do provedor.
    const studio = await videoSweep(await studioDeps(deps.sql), { deadline }).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    // Automações: eventos novos dos gatilhos e execuções cuja espera terminou.
    const automations = await automationSweep(await automationDeps(deps.sql, { background: true }), new Date(), { deadline }).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    // Conteúdo: posts na fila que já passaram da hora (Instagram e Facebook).
    const posts = await publishSweep(await contentDeps(deps.sql), new Date(), { deadline }).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    // Prospecção: passos vencidos da cadência (seg a sex, 9h às 18h, até o limite do dia).
    const prospect = await prospectSweep(deps.sql, whatsappSender(integrations), new Date(), { deadline }).catch((error) => `falhou: ${error instanceof Error ? error.message : error}`);
    // De novo no fim: pedidos vencidos e execuções encerradas avisam pelo canal.
    const delivered = await flushOutbox(channelDeps, ADAPTERS, { limit: 100, deadline });
    return NextResponse.json({ fx, ads, expiring, billing, cleanup, computers, routines, email, prospect, posts, automations, fiscal, aivis, studio, channels, delivered: { antes: queued, depois: delivered } });
  } catch (error) {
    return fail(error);
  }
}
