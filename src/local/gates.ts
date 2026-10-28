import type { Sql } from "../xodos/db";

/**
 * No Spherum, estas funções conferem assinatura, suspensão da agência, chaves de recurso e
 * contratos pausados. No app pessoal não há nada disso: só existe você, e os xodós param
 * apenas quando você os pausa (ou quando o teto de gasto do dia acaba, no orçamento).
 */

/** Motivo para os xodós não trabalharem agora, ou null. Pausar cada xodó é feito no próprio xodó. */
export async function xodoBlocked(_sql: Sql, _ownerId: string): Promise<string | null> {
  return null;
}

export async function assertAgencyActive(_sql: Sql, _ownerId: string): Promise<void> {}

export async function requireFeature(_sql: Sql, _key: string): Promise<void> {}

/** Sem plano: o limite de xodós é só o bom senso (e o gasto com IA). */
export async function assertLimit(_sql: Sql, _ownerId: string, _what: string, _adding = 1): Promise<void> {}
