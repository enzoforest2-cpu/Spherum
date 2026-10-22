import { randomUUID } from "node:crypto";
import { calculateCost, type AssistantMessage } from "@earendil-works/pi-ai";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { usdBrl } from "../xodos/fx";
import { serverLlm, type LlmClient } from "../xodos/llm";
import { loadCredentialSecret } from "../xodos/manage";
import { round6 } from "../xodos/pricing";
import { masterKeyFromEnv } from "../xodos/vault";
import { ENGINES, type AivisDeps, type Engine } from "./aivis";

/**
 * Pergunta aos modelos com a chave da própria agência (o modelo mais barato do catálogo de cada
 * provedor), como um usuário brasileiro perguntaria. O custo entra em ai_usage ("busca_ia").
 */

const SYSTEM = "Você é um assistente respondendo a uma pessoa no Brasil. Responda em português, de forma direta. Quando a pergunta pede indicações, liste nomes reais de empresas ou profissionais, em ordem de recomendação, numerados.";

function cheapest(llm: LlmClient, provider: string) {
  const models = llm.models(provider).filter((m) => m.cost.input > 0);
  models.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output));
  return models[0] ?? llm.models(provider)[0] ?? null;
}

export function aivisDeps(sql: Sql, llm: LlmClient = serverLlm(), masterKey = masterKeyFromEnv()): AivisDeps {
  return {
    sql,
    engines: async (agencyId) => {
      const rows = await sql.query<{ provider: string }>(`select distinct provider from ai_credentials where agency_id = $1 and revoked_at is null`, [agencyId]);
      return rows.map((r) => r.provider).filter((p): p is Engine => p in ENGINES && !!cheapest(llm, p));
    },
    ask: async (agencyId, engine, question) => {
      const cred = await one<{ id: string }>(sql, `select id from ai_credentials where agency_id = $1 and provider = $2 and revoked_at is null order by created_at limit 1`, [agencyId, engine]);
      if (!cred) throw new XodoError(`Sem chave de ${ENGINES[engine]}.`, 400);
      const secret = await loadCredentialSecret(sql, agencyId, cred.id, masterKey);
      const cat = cheapest(llm, engine);
      const model = cat && llm.resolve({ provider: engine, model: cat.id, baseUrl: secret.baseUrl });
      if (!model) throw new XodoError(`Nenhum modelo de ${ENGINES[engine]} no catálogo.`, 400);
      const msg: AssistantMessage = await llm.complete(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: question, timestamp: Date.now() }] }, { apiKey: secret.apiKey, maxTokens: 900, signal: AbortSignal.timeout(60_000) });
      const day = new Date().toISOString().slice(0, 10);
      const usd = msg.usage ? round6(msg.usage.cost?.total > 0 ? msg.usage.cost.total : calculateCost(model, msg.usage).total) : 0;
      const fx = await usdBrl(sql, day);
      const failed = msg.stopReason === "error" || msg.stopReason === "aborted";
      await sql.query(
        `insert into ai_usage (agency_id, provider, model, input_tokens, output_tokens, cost_usd, cost_source, usd_brl, cost_brl, attempt, error, call_id, day, purpose)
         values ($1, $2, $3, $4, $5, $6, 'catalog', $7, $8, 0, $9, $10, $11::date, 'busca_ia')`,
        [agencyId, engine, msg.responseModel ?? model.id, msg.usage?.input ?? 0, msg.usage?.output ?? 0, usd, fx, fx === null ? null : round6(usd * fx), failed ? (msg.errorMessage ?? "erro").slice(0, 500) : null, `aivis:${randomUUID()}`, day],
      );
      if (failed) throw new XodoError(msg.errorMessage ?? "O modelo não respondeu.", 502);
      const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n").trim();
      return { answer: text, model: model.id };
    },
  };
}
