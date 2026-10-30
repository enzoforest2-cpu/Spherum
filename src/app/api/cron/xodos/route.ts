import { timingSafeEqual } from "node:crypto";
import { cronAlerts } from "@/lib/core/alerts";
import { NextResponse } from "next/server";
import { billingDepsFromEnv, billingSweep } from "@/lib/billing";
import { ADAPTERS } from "@/lib/channels";
import { forwardSweep } from "@/lib/channels/notify-forward";
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
import { announcementSweep, recordCronRun } from "@/lib/core/admin";
import { adminDeps } from "@/lib/core/admin-deps";
import { mailerFromEnv } from "@/lib/core/email";
import { subDepsFromEnv, subscriptionSweep } from "@/lib/core/subscription";
import { cleanupPendingUploads, documentsStorage } from "@/lib/core/documents";
import { pushSweep } from "@/lib/core/push";
import { webhookSweep } from "@/lib/core/webhooks";
import { webPushSender } from "@/lib/core/push-web";
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
    const startedAt = new Date();
    const deps = await productionDeps();
    const channelDeps = deps as ChannelDeps;
    // Prazo interno abaixo do maxDuration: a fila não começa entregas que não dariam tempo de terminar.
    const deadline = Date.now() + 240_000;
    // Cada etapa é isolada: uma que falhe vira "falhou: …" na resposta e as outras rodam do mesmo jeito.
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | string> => {
      try {
        return await fn();
      } catch (error) {
        console.error(`[cron] ${name} falhou`, error);
        return `falhou: ${error instanceof Error ? error.message : error}`;
      }
    };
    // Primeiro o que é rápido e pendente desde o último ciclo: entregas dos canais e faxina.
    const channels = await step("canais", () => cleanupChannels(deps.sql, new Date()));
    const queued = await step("fila", () => flushOutbox(channelDeps, ADAPTERS, { limit: 100, deadline }));
    // Cotação falhando não impede o resto: o gasto usa a última conhecida.
    const fx = await step("cotacao", () => refreshFx(deps.sql, new Date()));
    const integrations = { sql: deps.sql, ...deps.integrations! };
    const ads = await step("anuncios", () => syncDueAccounts(integrations));
    const expiring = await step("logins", () => warnExpiringConnections(integrations));
    // Cobrança: faturas vencidas, mensalidades do mês e conferência das cobranças sem aviso (Itaú).
    const billing = await step("cobranca", () => billingSweep({ ...billingDepsFromEnv(deps.sql, integrations.masterKey) }, { deadline }));
    // Computador antes das retomadas (é rápido e fecha sessões que estão contando custo): dá como
    // pausadas as máquinas vencidas e pausa sessões longas; depois vence o controle de quem passou
    // do prazo (a execução retoma com "expired", até o prazo do cron).
    const machines = { ...withEngine(computerDeps(deps.sql), deps), deadline };
    const computers = await step("computador", async () => ({ controls: await expireControls(machines), ...(await sweepComputers(machines)) }));
    // Retomadas, fatias e rotinas param de começar perto do prazo; o resto fica para o próximo ciclo.
    const cleanup = await step("execucoes", () => sweep(deps, { deadline }));
    const routines = Date.now() < deadline - 30_000 ? await step("rotinas", () => runDueRoutines(deps, 5, { deadline })) : [];
    const email = await step("email", () => pollEmailTriggers(channelDeps));
    // Notas fiscais (emissão pela regra da agência e consulta na prefeitura) e régua de cobrança.
    const fiscal = await step("fiscal", async () => fiscalSweep(await fiscalDeps(deps.sql), new Date(), { deadline }));
    // Busca por IA: checagem semanal (segunda-feira) das perguntas de cada cliente.
    const aivis = Date.now() < deadline - 60_000 ? await step("busca_ia", () => weeklyChecks(aivisDeps(deps.sql), new Date(), { deadline })) : "sem tempo";
    // Estúdio: vídeos que ficaram prontos na fila do provedor.
    const studio = await step("estudio", async () => videoSweep(await studioDeps(deps.sql), { deadline }));
    // Automações: eventos novos dos gatilhos e execuções cuja espera terminou.
    const automations = await step("automacoes", async () => automationSweep(await automationDeps(deps.sql, { background: true }), new Date(), { deadline }));
    // Conteúdo: posts na fila que já passaram da hora (Instagram e Facebook).
    const posts = await step("posts", async () => publishSweep(await contentDeps(deps.sql), new Date(), { deadline }));
    // Prospecção: passos vencidos da cadência (seg a sex, 9h às 18h, até o limite do dia).
    const prospect = await step("prospeccao", () => prospectSweep(deps.sql, whatsappSender(integrations), new Date(), { deadline }));
    // App de celular: os avisos novos viram notificação nos aparelhos (se as chaves VAPID estiverem configuradas).
    const sender = webPushSender();
    const push = sender ? await step("push", () => pushSweep(deps.sql, sender, new Date(), { deadline })) : "sem VAPID";
    // Os mesmos avisos no Telegram e no WhatsApp de quem ligou o celular aos xodós.
    const forwarded = await step("avisos_canais", () => forwardSweep(channelDeps, ADAPTERS, new Date(), { deadline }));
    // Uploads que o navegador começou e nunca terminou.
    const uploads = await step("uploads", () => cleanupPendingUploads(deps.sql, documentsStorage(), new Date()));
    // Comunicados do Spherum agendados para agora.
    const comms = await step("comunicados", () => announcementSweep(adminDeps(deps.sql), new Date(), { deadline }));
    // Assinatura do Spherum: conferência no Asaas, renovações, atrasos e bloqueios.
    const subs = await step("assinaturas", () => subscriptionSweep(subDepsFromEnv(deps.sql, mailerFromEnv()), new Date(), { deadline }));
    // Webhooks da API: entregas na fila (assinadas), novas tentativas e desativação de endereços que só falham.
    const webhooks = await step("webhooks", () => webhookSweep(deps.sql, fetch, new Date(), { deadline }));
    // De novo no fim: pedidos vencidos e execuções encerradas avisam pelo canal.
    const delivered = await step("fila_fim", () => flushOutbox(channelDeps, ADAPTERS, { limit: 100, deadline }));
    const result = { fx, ads, expiring, billing, cleanup, computers, routines, email, prospect, posts, automations, fiscal, aivis, studio, push, forwarded, uploads, comms, subs, webhooks, channels, delivered: { antes: queued, depois: delivered } };
    // Registro da execução: o admin mostra a saúde de cada serviço pelas etapas que falharam.
    const steps: Record<string, unknown> = { canais: channels, fila: queued, cotacao: fx, anuncios: ads, logins: expiring, cobranca: billing, computador: computers, execucoes: cleanup, rotinas: routines, email, fiscal, busca_ia: aivis, estudio: studio, automacoes: automations, posts, prospeccao: prospect, push, avisos_canais: forwarded, uploads, comunicados: comms, assinaturas: subs, webhooks, fila_fim: delivered };
    await recordCronRun(deps.sql, startedAt, steps).catch((error) => console.error("[cron] registro falhou", error));
    // Etapa falhando em dois ciclos seguidos avisa a equipe do Spherum por e-mail.
    await cronAlerts(deps.sql, mailerFromEnv()).catch((error) => console.error("[cron] alerta falhou", error));
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
