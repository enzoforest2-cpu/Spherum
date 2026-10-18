import { calculateCost, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { reserveBudget, settleBudget } from "./budget";
import { num, type Sql } from "./db";
import { isSelfHosted, type LlmClient } from "./llm";
import { hasKnownPrice, round6, worstCaseUsd } from "./pricing";
import type { Xodo } from "./types";

/**
 * O "cérebro" do xodó: o modelo principal e os reservas, em ordem (como no Rakazo).
 *
 * Cada chamada tenta a partir do modelo que estava funcionando nesta execução. Se o
 * provedor falhar ou o modelo recusar, o próximo assume com a mesma conversa (a pi-ai
 * converte o histórico entre provedores). Toda tentativa entra no livro de gastos.
 */

export const MAX_TOKENS_PER_STEP = 8_000;
const CALL_TIMEOUT_MS = 180_000;

export type CredentialSecret = { provider: string; apiKey: string; baseUrl: string | null };

export type Candidate = { attempt: number; provider: string; model: string; credentialId: string | null };

export type BrainDeps = {
  sql: Sql;
  llm: LlmClient;
  secretFor: (agencyId: string, credentialId: string) => Promise<CredentialSecret>;
};

/**
 * Ordem dos modelos: principal (tentativa 0) e reservas (1, 2…). Nas rotinas, se a agência
 * escolheu um modelo para elas, ele vem antes e o principal vira o primeiro reserva.
 */
export async function loadCandidates(sql: Sql, xodo: Xodo, trigger: "user" | "routine" = "user"): Promise<Candidate[]> {
  const backups = await sql.query<{ position: number; provider: string; model: string; credential_id: string }>(
    `select position, provider, model, credential_id from xodo_models
      where xodo_id = $1 and agency_id = $2 order by position`,
    [xodo.id, xodo.agency_id],
  );
  const main = { provider: xodo.provider, model: xodo.model, credentialId: xodo.credential_id };
  const list = [main, ...backups.map((b) => ({ provider: b.provider, model: b.model, credentialId: b.credential_id }))];
  if (trigger === "routine" && xodo.routine_provider && xodo.routine_model) {
    list.unshift({ provider: xodo.routine_provider, model: xodo.routine_model, credentialId: xodo.routine_credential_id });
  }
  // O mesmo modelo com a mesma chave não é tentado duas vezes.
  const seen = new Set<string>();
  return list
    .filter((c) => {
      const key = `${c.provider}|${c.model}|${c.credentialId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c, attempt) => ({ attempt, ...c }));
}

type Ready = { model: Model<Api>; apiKey: string };

/** Decifra a chave e acha o modelo. Devolve o motivo quando o candidato não pode ser usado. */
export async function prepare(deps: BrainDeps, xodo: Xodo, candidate: Candidate): Promise<Ready | { problem: string }> {
  if (!candidate.credentialId) return { problem: "sem chave de API" };
  let secret: CredentialSecret;
  try {
    secret = await deps.secretFor(xodo.agency_id, candidate.credentialId);
  } catch (error) {
    return { problem: error instanceof Error ? error.message : "chave indisponível" };
  }
  if (secret.provider !== candidate.provider) return { problem: "a chave é de outro provedor" };
  const model = deps.llm.resolve({ provider: candidate.provider, model: candidate.model, baseUrl: secret.baseUrl });
  if (!model) return { problem: `o modelo ${candidate.model} não existe no catálogo de ${candidate.provider}` };
  return { model, apiKey: secret.apiKey };
}

/** Custo em US$ que a pi-ai calculou; se o provedor não informou, calcula pelo catálogo. */
function costOf(model: Model<Api>, message: AssistantMessage): number {
  const usage = message.usage;
  if (!usage) return 0;
  if (usage.cost?.total > 0 || usage.totalTokens === 0) return usage.cost?.total ?? 0;
  return calculateCost(model, usage).total;
}

export type CallInput = {
  xodo: Xodo;
  runId: string;
  step: number;
  day: string;
  /** Cotação do dólar do dia; nula se ainda não há nenhuma. */
  usdBrl: number | null;
  context: Context;
  candidates: Candidate[];
  startAt: number;
};

export type CallResult =
  | { ok: true; message: AssistantMessage; index: number }
  | { ok: false; reason: "budget"; cap: number }
  | { ok: false; reason: "refused" | "failed"; detail: AssistantMessage | null; problems: string[] };

export async function callWithFallback(deps: BrainDeps, input: CallInput): Promise<CallResult> {
  const { sql, llm } = deps;
  const { xodo, context } = input;
  const cap = xodo.daily_budget_brl === null ? null : num(xodo.daily_budget_brl);
  const promptChars = JSON.stringify(context).length;
  const problems: string[] = [];
  let lastFailure: AssistantMessage | null = null;
  let refusals = 0;
  let calls = 0;

  for (let index = input.startAt; index < input.candidates.length; index++) {
    const candidate = input.candidates[index];
    const ready = await prepare(deps, xodo, candidate);
    if ("problem" in ready) {
      problems.push(`${candidate.provider}/${candidate.model}: ${ready.problem}`);
      continue;
    }
    const maxTokens = Math.min(MAX_TOKENS_PER_STEP, ready.model.maxTokens || MAX_TOKENS_PER_STEP);

    // Teto opcional: reserva o pior caso em reais antes da chamada.
    let estimateBrl = 0;
    if (cap !== null && input.usdBrl !== null && hasKnownPrice(ready.model)) {
      estimateBrl = round6(worstCaseUsd(ready.model, promptChars, maxTokens) * input.usdBrl);
    }
    const reservation = await reserveBudget(sql, xodo, input.day, estimateBrl);
    if (!reservation.ok) return { ok: false, reason: "budget", cap: reservation.cap ?? 0 };

    calls += 1;
    const message = await llm.complete(ready.model, context, {
      apiKey: ready.apiKey,
      maxTokens,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    const costUsd = round6(costOf(ready.model, message));
    const costBrl = input.usdBrl === null ? null : round6(costUsd * input.usdBrl);
    const known = hasKnownPrice(ready.model) && !isSelfHosted(candidate.provider);
    await sql.query(
      `insert into ai_usage (agency_id, xodo_id, run_id, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, cost_source, usd_brl, cost_brl, attempt, error, call_id, day)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date)
       on conflict (call_id) do nothing`,
      [xodo.agency_id, xodo.id, input.runId, candidate.provider, message.responseModel ?? ready.model.id,
        message.usage?.input ?? 0, message.usage?.output ?? 0, message.usage?.cacheRead ?? 0, message.usage?.cacheWrite ?? 0,
        costUsd, known ? "catalog" : "unknown", input.usdBrl, costBrl, candidate.attempt,
        failed ? (message.errorMessage ?? message.stopReason).slice(0, 500) : null,
        `${input.runId}:${input.step}:${candidate.attempt}:${calls}`, input.day],
    );
    await settleBudget(sql, xodo, input.day, estimateBrl, costBrl ?? 0);

    if (!failed) return { ok: true, message, index };
    lastFailure = message;
    if (message.rawStopReason === "refusal") refusals += 1;
    problems.push(`${candidate.provider}/${candidate.model}: ${message.errorMessage ?? message.stopReason}`);
  }
  const allRefused = calls > 0 && refusals === calls;
  return { ok: false, reason: allRefused ? "refused" : "failed", detail: lastFailure, problems };
}
