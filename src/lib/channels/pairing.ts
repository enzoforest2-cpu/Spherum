import { randomInt } from "node:crypto";
import { one, type Sql } from "../xodos/db";
import { CAN_USE, type Role } from "../xodos/http";
import { sha256Hex } from "./security";
import type { ChannelKind } from "./types";

/**
 * Pareamento (modelo do Rakazo): no Spherum, a pessoa gera um código de 8 caracteres, válido
 * por 10 minutos e de uso único, e manda para o xodó no canal. Daí em diante aquela conta do
 * canal fala como ela, com o papel que ela tem na agência.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export function newPairingCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/** Código numa mensagem: aceita "ABCD2345", "/start ABCD2345", "vincular abcd-2345". */
export function extractPairingCode(text: string): string | null {
  const clean = text
    .trim()
    .replace(/^\/start(@\w+)?\s*/i, "")
    .replace(/^vincular\s*/i, "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
  return new RegExp(`^[${ALPHABET}]{8}$`).test(clean) ? clean : null;
}

/** Gera um código novo para a pessoa (o anterior deixa de valer). */
export async function createPairingCode(sql: Sql, agencyId: string, userId: string, now: Date) {
  const code = newPairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  await sql.transaction(async (tx) => {
    await tx.query(`delete from channel_pairing_codes where agency_id = $1 and user_id = $2`, [agencyId, userId]);
    await tx.query(`insert into channel_pairing_codes (code_hash, agency_id, user_id, expires_at) values ($1, $2, $3, $4::timestamptz)`, [
      sha256Hex(code),
      agencyId,
      userId,
      expiresAt.toISOString(),
    ]);
  });
  return { code, expiresAt };
}

/** Usa o código (uma vez só, e só na agência dona do canal). */
export async function redeemPairingCode(sql: Sql, agencyId: string, code: string, now: Date): Promise<string | null> {
  const row = await one<{ user_id: string }>(
    sql,
    `delete from channel_pairing_codes where code_hash = $1 and agency_id = $2 and expires_at > $3::timestamptz returning user_id`,
    [sha256Hex(code), agencyId, now.toISOString()],
  );
  return row?.user_id ?? null;
}

export async function linkIdentity(
  sql: Sql,
  input: { agencyId: string; provider: ChannelKind; externalUser: string; userId: string; displayName?: string | null },
) {
  await sql.query(
    `insert into channel_identities (agency_id, provider, external_user, user_id, display_name)
     values ($1, $2, $3, $4, $5)
     on conflict (agency_id, provider, external_user) do update set user_id = excluded.user_id, display_name = excluded.display_name`,
    [input.agencyId, input.provider, input.externalUser, input.userId, input.displayName ?? null],
  );
}

/** Pessoa da equipe por trás de uma conta do canal, se ainda estiver na agência com papel que pode usar xodós. */
export async function identityFor(
  sql: Sql,
  agencyId: string,
  provider: ChannelKind,
  externalUser: string,
): Promise<{ userId: string; role: Role; displayName: string | null } | null> {
  const row = await one<{ user_id: string; role: Role; display_name: string | null }>(
    sql,
    `select i.user_id, m.role, i.display_name from channel_identities i
       join agency_members m on m.agency_id = i.agency_id and m.user_id = i.user_id
      where i.agency_id = $1 and i.provider = $2 and i.external_user = $3`,
    [agencyId, provider, externalUser],
  );
  if (!row || !CAN_USE.includes(row.role)) return null;
  return { userId: row.user_id, role: row.role, displayName: row.display_name };
}
