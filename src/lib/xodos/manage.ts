import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CredentialSecret } from "./brain";
import { one, type Sql } from "./db";
import { isSelfHosted, type LlmClient } from "./llm";
import { assertPublicUrl, type Resolver } from "./net";
import { greeting } from "./persona";
import { addMessage, XodoError } from "./runner";
import { AUTONOMY, PERSONALITIES, SPECIES, type Xodo } from "./types";
import { credentialAad, lastFour, openSecret, sealSecret } from "./vault";

/** Cadastro de chaves de API e de xodós. Toda função recebe agencyId e filtra por ele. */

export const MAX_BACKUP_MODELS = 5;

// ---------------------------------------------------------------------------
// Chaves de API
// ---------------------------------------------------------------------------

export const credentialInput = z.object({
  provider: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  api_key: z.string().trim().max(500).default(""),
  base_url: z.string().trim().max(300).optional(),
});

export async function createCredential(
  sql: Sql,
  llm: LlmClient,
  agencyId: string,
  raw: unknown,
  createdBy: string | null,
  masterKey: string,
  resolve?: Resolver,
) {
  const input = credentialInput.parse(raw);
  if (!llm.providers().some((p) => p.id === input.provider)) {
    throw new XodoError(`Provedor desconhecido: ${input.provider}.`);
  }
  let baseUrl: string | null = null;
  if (isSelfHosted(input.provider)) {
    if (!input.base_url) throw new XodoError("Informe o endereço do servidor (ex.: https://meu-ollama.exemplo.com/v1).");
    try {
      baseUrl = (await assertPublicUrl(input.base_url, resolve)).toString().replace(/\/+$/, "");
    } catch (error) {
      throw new XodoError(error instanceof Error ? error.message : "Endereço inválido.");
    }
  } else if (input.api_key.length < 8) {
    throw new XodoError("Cole a chave de API completa.");
  }
  // Servidor local pode não ter chave; guardamos a chave vazia cifrada para manter um formato só.
  const id = randomUUID();
  const ciphertext = await sealSecret(input.api_key, credentialAad(agencyId, id), masterKey);
  return one<{ id: string; provider: string; label: string; base_url: string | null; key_last4: string }>(
    sql,
    `insert into ai_credentials (id, agency_id, provider, label, base_url, ciphertext, key_last4, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, provider, label, base_url, key_last4`,
    [id, agencyId, input.provider, input.label, baseUrl, ciphertext, lastFour(input.api_key), createdBy],
  );
}

export async function listCredentials(sql: Sql, agencyId: string) {
  return sql.query(
    `select id, provider, label, base_url, key_last4, created_at::text, revoked_at::text
       from ai_credentials where agency_id = $1 order by created_at desc`,
    [agencyId],
  );
}

export async function revokeCredential(sql: Sql, agencyId: string, credentialId: string) {
  const row = await one(
    sql,
    `update ai_credentials set revoked_at = now() where id = $1 and agency_id = $2 and revoked_at is null returning id`,
    [credentialId, agencyId],
  );
  if (!row) throw new XodoError("Chave não encontrada", 404);
}

/** Decifra a chave só no momento da chamada; ela nunca é gravada em outro lugar. */
export async function loadCredentialSecret(
  sql: Sql,
  agencyId: string,
  credentialId: string,
  masterKey: string,
): Promise<CredentialSecret> {
  const row = await one<{ provider: string; base_url: string | null; ciphertext: string }>(
    sql,
    `select provider, base_url, ciphertext from ai_credentials where id = $1 and agency_id = $2 and revoked_at is null`,
    [credentialId, agencyId],
  );
  if (!row) throw new XodoError("A chave de API foi revogada ou não existe nesta agência.", 422);
  const apiKey = await openSecret(row.ciphertext, credentialAad(agencyId, credentialId), masterKey);
  return { provider: row.provider, apiKey, baseUrl: row.base_url };
}

// ---------------------------------------------------------------------------
// Xodós
// ---------------------------------------------------------------------------

const modelChoice = z.object({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(200),
  credential_id: z.uuid(),
});

/** O que a pessoa escolhe no assistente de criação do design (forma, cor, nome e jeito, cérebro, limites). */
export const xodoInput = z.object({
  name: z.string().trim().min(1).max(40),
  species: z.enum(SPECIES),
  color: z.string().trim().min(1).max(20),
  personality: z.enum(PERSONALITIES),
  role: z.string().trim().min(1).max(40).nullable().default(null),
  instructions: z.string().max(8000).default(""),
  autonomy: z.enum(AUTONOMY).default("pergunta_no_que_importa"),
  ...modelChoice.shape,
  /** Modelos reserva, em ordem. */
  backup_models: z.array(modelChoice).max(MAX_BACKUP_MODELS).default([]),
  /** Teto do dia em reais; ausente ou nulo: só registra o gasto. */
  daily_budget_brl: z.number().positive().max(100_000).nullable().default(null),
  warn_at_percent: z.number().int().min(1).max(99).default(80),
  timezone: z.string().default("America/Sao_Paulo"),
  client_ids: z.array(z.uuid()).max(500).optional(),
});

export const xodoPatch = xodoInput
  .omit({ timezone: true, client_ids: true })
  .extend({ status: z.enum(["active", "paused"]) })
  .partial();

/** A chave precisa ser desta agência, do mesmo provedor, e o modelo precisa existir no catálogo. */
async function assertModelChoice(sql: Sql, llm: LlmClient, agencyId: string, choice: z.infer<typeof modelChoice>) {
  const credential = await one<{ base_url: string | null }>(
    sql,
    `select base_url from ai_credentials where id = $1 and agency_id = $2 and provider = $3 and revoked_at is null`,
    [choice.credential_id, agencyId, choice.provider],
  );
  if (!credential) throw new XodoError("A chave escolhida não existe nesta agência ou é de outro provedor.");
  if (!llm.resolve({ provider: choice.provider, model: choice.model, baseUrl: credential.base_url })) {
    throw new XodoError(`O modelo ${choice.model} não está no catálogo de ${choice.provider}.`);
  }
}

async function saveBackups(sql: Sql, agencyId: string, xodoId: string, backups: z.infer<typeof modelChoice>[]) {
  await sql.query(`delete from xodo_models where xodo_id = $1 and agency_id = $2`, [xodoId, agencyId]);
  for (const [i, b] of backups.entries()) {
    await sql.query(
      `insert into xodo_models (xodo_id, agency_id, position, provider, model, credential_id) values ($1, $2, $3, $4, $5, $6)`,
      [xodoId, agencyId, i + 1, b.provider, b.model, b.credential_id],
    );
  }
}

export async function createXodo(sql: Sql, llm: LlmClient, agencyId: string, raw: unknown, createdBy: string | null): Promise<Xodo> {
  const input = xodoInput.parse(raw);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw new XodoError("Fuso horário inválido.");
  }
  for (const choice of [input, ...input.backup_models]) await assertModelChoice(sql, llm, agencyId, choice);
  const scope = input.client_ids ? "selected" : "all";
  const clientIds = [...new Set(input.client_ids ?? [])];
  if (clientIds.length) {
    const [found] = await sql.query<{ n: unknown }>(
      `select count(*) as n from clients where agency_id = $1 and id = any($2::uuid[])`,
      [agencyId, clientIds],
    );
    if (Number(found.n) !== clientIds.length) throw new XodoError("Algum cliente escolhido não é desta agência.");
  }

  return sql.transaction(async (tx) => {
    await assertNameFree(tx, agencyId, input.name);
    const xodo = await one<Xodo>(
      tx,
      `insert into xodos (agency_id, name, species, color, personality, role, instructions, autonomy, provider, model,
         credential_id, daily_budget_brl, warn_at_percent, timezone, client_scope, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
      [agencyId, input.name, input.species, input.color, input.personality, input.role, input.instructions, input.autonomy,
        input.provider, input.model, input.credential_id, input.daily_budget_brl, input.warn_at_percent, input.timezone,
        scope, createdBy],
    );
    await saveBackups(tx, agencyId, xodo!.id, input.backup_models);
    for (const clientId of clientIds) {
      // O gatilho do banco também recusa cliente de outra agência.
      await tx.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [xodo!.id, clientId, agencyId]);
    }
    await addMessage(tx, xodo!, null, "assistant", greeting(xodo!), null);
    return xodo!;
  });
}

export async function updateXodo(sql: Sql, llm: LlmClient, agencyId: string, xodoId: string, raw: unknown): Promise<Xodo> {
  const patch = xodoPatch.parse(raw);
  const current = await one<Xodo>(sql, `select * from xodos where id = $1 and agency_id = $2`, [xodoId, agencyId]);
  if (!current) throw new XodoError("Xodó não encontrado", 404);
  // Cérebro trocável: mudar de provedor exige o modelo e a chave do novo provedor.
  const switchesProvider = patch.provider !== undefined && patch.provider !== current.provider;
  if (switchesProvider && (!patch.model || !patch.credential_id)) {
    throw new XodoError("Para trocar o cérebro, informe o modelo e a chave do novo provedor.");
  }
  const next = { ...current, ...patch };
  if (patch.provider || patch.model || patch.credential_id) {
    if (!next.credential_id) throw new XodoError("Escolha uma chave de API.");
    await assertModelChoice(sql, llm, agencyId, { provider: next.provider, model: next.model, credential_id: next.credential_id });
  }
  for (const backup of patch.backup_models ?? []) await assertModelChoice(sql, llm, agencyId, backup);
  if (patch.name && patch.name !== current.name) await assertNameFree(sql, agencyId, patch.name);
  return sql.transaction(async (tx) => {
    const row = await one<Xodo>(
      tx,
      `update xodos set name = $3, species = $4, color = $5, personality = $6, role = $7, instructions = $8, autonomy = $9,
              provider = $10, model = $11, credential_id = $12, daily_budget_brl = $13, warn_at_percent = $14, status = $15,
              updated_at = now()
        where id = $1 and agency_id = $2 returning *`,
      [xodoId, agencyId, next.name, next.species, next.color, next.personality, next.role, next.instructions, next.autonomy,
        next.provider, next.model, next.credential_id, next.daily_budget_brl, next.warn_at_percent, next.status],
    );
    if (patch.backup_models) await saveBackups(tx, agencyId, xodoId, patch.backup_models);
    return row!;
  });
}

async function assertNameFree(sql: Sql, agencyId: string, name: string) {
  const taken = await one(sql, `select 1 from xodos where agency_id = $1 and name = $2`, [agencyId, name]);
  if (taken) throw new XodoError(`Já existe um xodó chamado ${name}.`, 409);
}
