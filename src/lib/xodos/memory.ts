import { one, type Sql } from "./db";

/**
 * Memória do xodó: um texto curto que entra em toda conversa (ideia do OpenMausBot).
 *
 * Cada gravação guarda a versão anterior para desfazer, e segredos são apagados antes de
 * salvar, porque a memória volta para o modelo em todas as chamadas seguintes.
 */

export const MEMORY_MAX_CHARS = 24_000;

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
];
const LABELLED_SECRET = /\b(senha|password|token|api[ _-]?key|chave de api|secret)(\s*[:=]\s*)\S+/gi;
// Cartões: 4 grupos de 4 ou 15–16 dígitos seguidos começando com 3–6. IDs de campanha
// (Meta com 17–18 dígitos, Google com 10–11) ficam de fora.
const CARD_CANDIDATE = /\b(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}|[3-6]\d{14,15})\b/g;

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[removido]");
  out = out.replace(LABELLED_SECRET, (_m, label: string, sep: string) => `${label}${sep}[removido]`);
  out = out.replace(CARD_CANDIDATE, (match) => (luhn(match.replace(/\D/g, "")) ? "[removido]" : match));
  return { text: out, redacted: out !== text };
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export async function loadMemory(sql: Sql, agencyId: string, xodoId: string): Promise<string> {
  const row = await one<{ content: string }>(
    sql,
    `select content from xodo_memories where xodo_id = $1 and agency_id = $2`,
    [xodoId, agencyId],
  );
  return row?.content ?? "";
}

export async function saveMemory(
  sql: Sql,
  agencyId: string,
  xodoId: string,
  content: string,
  reason: string,
): Promise<{ content: string; redacted: boolean }> {
  const clean = redactSecrets(content.trim());
  if (clean.text.length > MEMORY_MAX_CHARS) {
    throw new Error(`A memória passou de ${MEMORY_MAX_CHARS} caracteres. Resuma antes de salvar.`);
  }
  await sql.transaction(async (tx) => {
    const previous = await loadMemory(tx, agencyId, xodoId);
    await tx.query(
      `insert into xodo_memory_revisions (xodo_id, agency_id, content, reason) values ($1, $2, $3, $4)`,
      [xodoId, agencyId, previous, reason.slice(0, 200)],
    );
    await tx.query(
      `insert into xodo_memories (xodo_id, agency_id, content, updated_at) values ($1, $2, $3, now())
       on conflict (xodo_id) do update set content = excluded.content, updated_at = now()`,
      [xodoId, agencyId, clean.text],
    );
  });
  return { content: clean.text, redacted: clean.redacted };
}

/** Volta a memória para uma versão anterior (a atual vira uma revisão, então dá para refazer). */
export async function restoreMemory(sql: Sql, agencyId: string, xodoId: string, revisionId: number) {
  const revision = await one<{ content: string }>(
    sql,
    `select content from xodo_memory_revisions where id = $1 and xodo_id = $2 and agency_id = $3`,
    [revisionId, xodoId, agencyId],
  );
  if (!revision) throw new Error("Versão da memória não encontrada");
  return saveMemory(sql, agencyId, xodoId, revision.content, `restaurou a versão ${revisionId}`);
}
