import { randomBytes } from "node:crypto";
import { calculateCost, type AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { IntegrationError, requestJson } from "../integrations/http";
import { metaGraph } from "../integrations/oauth-providers";
import { access, type IntegrationDeps } from "../integrations/store";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { usdBrl } from "../xodos/fx";
import type { LlmClient } from "../xodos/llm";
import { loadCredentialSecret } from "../xodos/manage";
import { round6 } from "../xodos/pricing";
import { getConfig, PLACEHOLDERS } from "./prospect";
import { ADDONS, addonState, rankOf, type PlanId } from "./subscription";

/**
 * Disparos com variação automática (add-on "disp"; incluso a partir do Escala): a IA da agência
 * escreve variações da primeira mensagem, o Spherum manda cada uma para a Meta aprovar como modelo
 * de mensagem (a Meta só aceita começar conversa com modelo aprovado) e liga as aprovadas no
 * revezamento dos disparos. Nada de texto reescrito a cada envio para escapar de bloqueio: todas as
 * variações são modelos aprovados e a taxa de resposta de cada uma aparece em Disparos.
 */

export type VariationDeps = { sql: Sql; llm: LlmClient; masterKey: string; integrations: IntegrationDeps };

async function assertAddon(sql: Sql, agencyId: string) {
  const a = await one<{ plan: PlanId; plan_status: string; qty: number | null }>(sql,
    `select a.plan, a.plan_status, (select qty from agency_addons where agency_id = a.id and addon_id = 'disp') as qty from agencies a where a.id = $1`, [agencyId]);
  if (!a) throw new XodoError("Agência não encontrada.", 404);
  const st = addonState(ADDONS.disp, rankOf(a.plan_status === "trial" ? "agencia" : a.plan));
  if (st === "incl" || (st === "buy" && (a.qty ?? 0) > 0)) return;
  throw new XodoError(st === "lock" ? "Disparos com variação começam no plano Agência, como add-on." : "Contrate “Disparos com variação de mensagem” em Configurações → Plano e cobrança (já vem no Escala).", 402);
}

const genInput = z.object({
  base: z.string().trim().min(10).max(1024),
  count: z.number().int().min(2).max(6).default(4),
  tone: z.string().trim().max(80).optional(),
});

const SYSTEM = `Você escreve mensagens de primeiro contato pelo WhatsApp para uma agência de marketing no Brasil.
Regras: português do Brasil; curtas (até 400 caracteres); educadas; sem promessas exageradas; sem links; sem emojis em excesso (no máximo 1).
Só use as variáveis {nome}, {empresa}, {segmento} e {cidade}, escritas exatamente assim, e nenhuma outra chave.
Cada variação deve ter um jeito diferente de abrir a conversa (pergunta, elogio ao negócio, dado do segmento, convite direto).
Responda só com JSON: {"variacoes":[{"estilo":"nome curto do jeito","texto":"..."}]}`;

/** Escreve variações com a chave de IA da agência (o modelo mais barato do provedor). Não grava nada. */
export async function generateVariations(deps: VariationDeps, agencyId: string, raw: unknown) {
  await assertAddon(deps.sql, agencyId);
  const i = genInput.parse(raw);
  const cred = await one<{ id: string; provider: string }>(deps.sql,
    `select id, provider from ai_credentials where agency_id = $1 and revoked_at is null and kind <> 'sandbox' order by created_at limit 1`, [agencyId]).catch(() =>
    one<{ id: string; provider: string }>(deps.sql, `select id, provider from ai_credentials where agency_id = $1 and revoked_at is null order by created_at limit 1`, [agencyId]));
  if (!cred) throw new XodoError("Cadastre uma chave de IA em Xodós para a IA escrever as variações.", 409);
  const secret = await loadCredentialSecret(deps.sql, agencyId, cred.id, deps.masterKey);
  const cat = deps.llm.models(cred.provider).filter((m) => m.cost.input > 0).sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0] ?? deps.llm.models(cred.provider)[0];
  const model = cat && deps.llm.resolve({ provider: cred.provider, model: cat.id, baseUrl: secret.baseUrl });
  if (!model) throw new XodoError("Nenhum modelo dessa chave de IA no catálogo.", 400);
  const prompt = `Mensagem base:\n${i.base}\n\nEscreva ${i.count} variações${i.tone ? ` com tom ${i.tone}` : ""}.`;
  const msg: AssistantMessage = await deps.llm.complete(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { apiKey: secret.apiKey, maxTokens: 1500, signal: AbortSignal.timeout(60_000) });
  const day = new Date().toISOString().slice(0, 10), fx = await usdBrl(deps.sql, day);
  const usd = msg.usage ? round6(msg.usage.cost?.total > 0 ? msg.usage.cost.total : calculateCost(model, msg.usage).total) : 0;
  const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
  await deps.sql.query(
    `insert into ai_usage (agency_id, provider, model, input_tokens, output_tokens, cost_usd, cost_source, usd_brl, cost_brl, attempt, error, call_id, day, purpose)
     values ($1, $2, $3, $4, $5, $6, 'catalog', $7, $8, 0, $9, $10, $11::date, 'prospeccao')`,
    [agencyId, cred.provider, msg.responseModel ?? model.id, msg.usage?.input ?? 0, msg.usage?.output ?? 0, usd, fx, fx === null ? null : round6(usd * fx),
      failed ? (msg.errorMessage ?? "erro").slice(0, 500) : null, `variacoes:${randomBytes(6).toString("hex")}`, day],
  );
  if (failed) throw new XodoError(msg.errorMessage ?? "A IA não respondeu. Tente de novo.", 502);
  const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  let parsed: { variacoes?: { estilo?: string; texto?: string }[] } = {};
  try { parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { /* resposta fora do formato */ }
  const ok = (t: string) => [...t.matchAll(/\{([^{}]+)\}/g)].every((m) => (PLACEHOLDERS as readonly string[]).includes(m[1])) && !/\{[^{}]*\|[^{}]*\}/.test(t);
  const out = (parsed.variacoes ?? [])
    .map((v) => ({ style: String(v.estilo ?? "Variação").trim().slice(0, 40) || "Variação", text: String(v.texto ?? "").trim().slice(0, 1024) }))
    .filter((v) => v.text.length >= 5 && ok(v.text));
  if (!out.length) throw new XodoError("A IA não devolveu variações válidas. Tente de novo.", 502);
  return { variations: out.slice(0, i.count) };
}

// ---------------------------------------------------------------------------
// Modelos na Meta
// ---------------------------------------------------------------------------

const submitInput = z.object({
  waba_id: z.string().trim().regex(/^\d{5,25}$/, "O ID da conta do WhatsApp Business tem só dígitos (no WhatsApp Manager)."),
  style: z.string().trim().min(1).max(40),
  text: z.string().trim().min(5).max(1024),
});

/** {nome} → {{1}}… na ordem em que aparecem (como a prospecção preenche ao enviar), com exemplo para a Meta. */
export function toMetaBody(text: string) {
  const EX: Record<string, string> = { nome: "Ana", empresa: "Padaria Sol", segmento: "padarias", cidade: "Campinas" };
  const order: string[] = [];
  const body = text.replace(/\{(nome|empresa|segmento|cidade)\}/g, (_, k: string) => { order.push(k); return `{{${order.length}}}`; });
  return { body, examples: order.map((k) => EX[k]) };
}

async function cloudToken(deps: VariationDeps, agencyId: string) {
  const cfg = await getConfig(deps.sql, agencyId);
  if (!cfg.connection_id) throw new XodoError("Escolha o número do WhatsApp oficial em Cadência primeiro.", 409);
  return { cfg, token: (await access(deps.integrations, agencyId, cfg.connection_id)).accessToken };
}

/** Manda a variação para a Meta aprovar e guarda na lista de variações, desligada até aprovar. */
export async function submitVariation(deps: VariationDeps, agencyId: string, raw: unknown) {
  await assertAddon(deps.sql, agencyId);
  const i = submitInput.parse(raw);
  const { cfg, token } = await cloudToken(deps, agencyId);
  if (cfg.variations.length >= 8) throw new XodoError("No máximo 8 variações. Apague uma antes.", 409);
  const name = `spherum_v_${randomBytes(4).toString("hex")}`;
  const { body, examples } = toMetaBody(i.text);
  try {
    await requestJson(deps.integrations.fetch, `${metaGraph()}/${i.waba_id}/message_templates`, {
      method: "POST", bearer: token,
      json: { name, language: cfg.lang, category: "MARKETING", components: [{ type: "BODY", text: body, ...(examples.length ? { example: { body_text: [examples] } } : {}) }] },
    });
  } catch (error) {
    if (error instanceof IntegrationError) throw new XodoError(`A Meta não aceitou o modelo: ${error.message}`, 400);
    throw error;
  }
  const variations = [...cfg.variations, { style: i.style, text: i.text, template: name, on: false, status: "PENDING" }];
  await deps.sql.query(`update agencies set prospect_config = prospect_config || $2::jsonb where id = $1`, [agencyId, json({ variations, waba_id: i.waba_id })]);
  return { template: name, status: "PENDING" };
}

/** Confere na Meta a situação dos modelos das variações; aprovado liga, recusado fica desligado com o motivo. */
export async function syncVariations(deps: VariationDeps, agencyId: string) {
  const { cfg, token } = await cloudToken(deps, agencyId);
  const waba = cfg.waba_id;
  if (!waba) return { variations: cfg.variations };
  const r = await requestJson<{ data?: { name: string; status: string; rejected_reason?: string }[] }>(deps.integrations.fetch,
    `${metaGraph()}/${waba}/message_templates?fields=name,status,rejected_reason&limit=200`, { bearer: token });
  const byName = new Map((r.data ?? []).map((t) => [t.name, t]));
  const variations = cfg.variations.map((v) => {
    const t = v.template ? byName.get(v.template) : undefined;
    if (!t) return v;
    const approved = t.status === "APPROVED";
    const was = (v as { status?: string }).status;
    return { ...v, status: t.status, reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null, on: approved ? (was === "APPROVED" ? v.on : true) : false };
  });
  await deps.sql.query(`update agencies set prospect_config = prospect_config || $2::jsonb where id = $1`, [agencyId, json({ variations })]);
  return { variations };
}
