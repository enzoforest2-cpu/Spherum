import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, type Sql } from "./db";
import { greeting } from "./persona";
import { addMessage, XodoError } from "./runner";
import { AUTONOMY, PERSONALITIES, PROVIDERS, SPECIES, type Xodo } from "./types";
import { credentialAad, lastFour, openSecret, sealSecret } from "./vault";

/** Cadastro de chaves de API e de xodós. Toda função recebe agencyId e filtra por ele. */

// ---------------------------------------------------------------------------
// Chaves de API
// ---------------------------------------------------------------------------

export const credentialInput = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().trim().min(1).max(60),
  api_key: z.string().trim().min(20).max(500),
});

export async function createCredential(
  sql: Sql,
  agencyId: string,
  input: z.infer<typeof credentialInput>,
  createdBy: string | null,
  masterKey: string,
) {
  const id = randomUUID();
  const ciphertext = await sealSecret(input.api_key, credentialAad(agencyId, id), masterKey);
  return one<{ id: string; provider: string; label: string; key_last4: string }>(
    sql,
    `insert into ai_credentials (id, agency_id, provider, label, ciphertext, key_last4, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, provider, label, key_last4`,
    [id, agencyId, input.provider, input.label, ciphertext, lastFour(input.api_key), createdBy],
  );
}

export async function listCredentials(sql: Sql, agencyId: string) {
  return sql.query(
    `select id, provider, label, key_last4, created_at::text, revoked_at::text
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

/** Decifra a chave do xodó só no momento da chamada; ela nunca é gravada em outro lugar. */
export async function loadApiKey(sql: Sql, xodo: Xodo, masterKey: string): Promise<string> {
  if (!xodo.credential_id) throw new XodoError(`${xodo.name} está sem chave de API.`, 422);
  const row = await one<{ ciphertext: string }>(
    sql,
    `select ciphertext from ai_credentials
      where id = $1 and agency_id = $2 and provider = $3 and revoked_at is null`,
    [xodo.credential_id, xodo.agency_id, xodo.provider],
  );
  if (!row) throw new XodoError(`A chave de API de ${xodo.name} foi revogada ou não é do provedor ${xodo.provider}.`, 422);
  return openSecret(row.ciphertext, credentialAad(xodo.agency_id, xodo.credential_id), masterKey);
}

// ---------------------------------------------------------------------------
// Xodós
// ---------------------------------------------------------------------------

/** O que a pessoa escolhe no assistente de criação do design (forma, cor, nome e jeito, cérebro, limites). */
export const xodoInput = z.object({
  name: z.string().trim().min(1).max(40),
  species: z.enum(SPECIES),
  color: z.string().trim().min(1).max(20),
  personality: z.enum(PERSONALITIES),
  role: z.string().trim().min(1).max(40).nullable().default(null),
  instructions: z.string().max(8000).default(""),
  autonomy: z.enum(AUTONOMY).default("pergunta_no_que_importa"),
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1).max(100),
  credential_id: z.uuid(),
  daily_budget_usd: z.number().positive().max(1000).default(2),
  warn_at_percent: z.number().int().min(1).max(99).default(80),
  timezone: z.string().default("America/Sao_Paulo"),
  client_ids: z.array(z.uuid()).max(500).optional(),
});

export const xodoPatch = xodoInput
  .omit({ timezone: true, client_ids: true })
  .extend({ status: z.enum(["active", "paused"]) })
  .partial();

async function assertCredential(sql: Sql, agencyId: string, credentialId: string, provider: string) {
  const ok = await one(
    sql,
    `select 1 from ai_credentials where id = $1 and agency_id = $2 and provider = $3 and revoked_at is null`,
    [credentialId, agencyId, provider],
  );
  if (!ok) throw new XodoError("A chave escolhida não existe nesta agência ou é de outro provedor.");
}

export async function createXodo(sql: Sql, agencyId: string, raw: unknown, createdBy: string | null): Promise<Xodo> {
  const input = xodoInput.parse(raw);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw new XodoError("Fuso horário inválido.");
  }
  await assertCredential(sql, agencyId, input.credential_id, input.provider);
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
         credential_id, daily_budget_usd, warn_at_percent, timezone, client_scope, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
      [agencyId, input.name, input.species, input.color, input.personality, input.role, input.instructions, input.autonomy,
        input.provider, input.model, input.credential_id, input.daily_budget_usd, input.warn_at_percent, input.timezone,
        scope, createdBy],
    );
    for (const clientId of clientIds) {
      // O gatilho do banco também recusa cliente de outra agência.
      await tx.query(`insert into xodo_clients (xodo_id, client_id, agency_id) values ($1, $2, $3)`, [xodo!.id, clientId, agencyId]);
    }
    await addMessage(tx, xodo!, null, "assistant", greeting(xodo!), null);
    return xodo!;
  });
}

export async function updateXodo(sql: Sql, agencyId: string, xodoId: string, raw: unknown): Promise<Xodo> {
  const patch = xodoPatch.parse(raw);
  const current = await one<Xodo>(sql, `select * from xodos where id = $1 and agency_id = $2`, [xodoId, agencyId]);
  if (!current) throw new XodoError("Xodó não encontrado", 404);
  // Cérebro trocável: mudar de provedor exige o modelo e a chave do novo provedor.
  const switchesProvider = patch.provider !== undefined && patch.provider !== current.provider;
  if (switchesProvider && (!patch.model || !patch.credential_id)) {
    throw new XodoError("Para trocar o cérebro, informe o modelo e a chave do novo provedor.");
  }
  const next = { ...current, ...patch };
  if (patch.credential_id || switchesProvider) await assertCredential(sql, agencyId, next.credential_id!, next.provider);
  if (patch.name && patch.name !== current.name) await assertNameFree(sql, agencyId, patch.name);
  const row = await one<Xodo>(
    sql,
    `update xodos set name = $3, species = $4, color = $5, personality = $6, role = $7, instructions = $8, autonomy = $9,
            provider = $10, model = $11, credential_id = $12, daily_budget_usd = $13, warn_at_percent = $14, status = $15,
            updated_at = now()
      where id = $1 and agency_id = $2 returning *`,
    [xodoId, agencyId, next.name, next.species, next.color, next.personality, next.role, next.instructions, next.autonomy,
      next.provider, next.model, next.credential_id, next.daily_budget_usd, next.warn_at_percent, next.status],
  );
  return row!;
}

async function assertNameFree(sql: Sql, agencyId: string, name: string) {
  const taken = await one(sql, `select 1 from xodos where agency_id = $1 and name = $2`, [agencyId, name]);
  if (taken) throw new XodoError(`Já existe um xodó chamado ${name}.`, 409);
}
