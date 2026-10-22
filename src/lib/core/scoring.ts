import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/**
 * Pontuação de leads: soma dos pontos dos critérios ativos que o negócio atende, de 0 a 100.
 * Critérios automáticos olham os dados do negócio; os manuais são marcados pela equipe.
 */

export const rule = z.object({
  k: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  l: z.string().trim().min(1).max(120),
  p: z.number().int().min(-50).max(50),
  on: z.boolean().default(true),
  kind: z.enum(["manual", "valor", "origem", "segmento", "email", "telefone", "resposta"]).default("manual"),
  // valor: mínimo em reais; origem/segmento/resposta: texto procurado (sem diferença de maiúsculas e acentos).
  value: z.string().trim().max(120).optional(),
});
export type Rule = z.infer<typeof rule>;

export const scoringInput = z.object({ hot: z.number().int().min(10).max(100), warm: z.number().int().min(5).max(95), rules: z.array(rule).max(50) })
  .refine((s) => s.warm < s.hot, { message: "A faixa morna fica abaixo da quente." });
export type Scoring = z.infer<typeof scoringInput>;

export const DEFAULT_SCORING: Scoring = {
  hot: 70, warm: 40,
  rules: [
    { k: "valor", l: "Valor mensal a partir de R$ 3.000", p: 30, on: true, kind: "valor", value: "3000" },
    { k: "telefone", l: "Deixou o WhatsApp", p: 20, on: true, kind: "telefone" },
    { k: "email", l: "Deixou o e-mail", p: 10, on: true, kind: "email" },
    { k: "indicacao", l: "Veio por indicação", p: 25, on: true, kind: "origem", value: "Indicação" },
  ],
};

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export type ScoredDeal = { value_cents: number; source: string | null; segment: string | null; email: string | null; phone: string | null; notes: string | null; score_flags?: string[] | null };

/** Critérios que o negócio atende. */
export function matches(r: Rule, d: ScoredDeal): boolean {
  switch (r.kind) {
    case "manual": return (d.score_flags ?? []).includes(r.k);
    case "valor": return d.value_cents / 100 >= Number(r.value ?? 0);
    case "origem": return !!r.value && norm(d.source) === norm(r.value);
    case "segmento": return !!r.value && norm(d.segment).includes(norm(r.value));
    case "email": return !!d.email;
    case "telefone": return !!d.phone;
    case "resposta": return !!r.value && norm(d.notes).includes(norm(r.value));
  }
}

export function scoreDeal(s: Scoring, d: ScoredDeal) {
  const hit = s.rules.filter((r) => r.on && matches(r, d));
  const score = Math.max(0, Math.min(100, hit.reduce((t, r) => t + r.p, 0)));
  return { score, temp: score >= s.hot ? "quente" : score >= s.warm ? "morno" : "frio", reasons: hit.map((r) => r.k) };
}

export async function getScoring(sql: Sql, agencyId: string): Promise<Scoring> {
  const a = await one<{ lead_scoring: Scoring | null }>(sql, `select lead_scoring from agencies where id = $1`, [agencyId]);
  return a?.lead_scoring ? scoringInput.parse(a.lead_scoring) : DEFAULT_SCORING;
}

export async function setScoring(sql: Sql, agencyId: string, raw: unknown) {
  const s = scoringInput.parse(raw);
  if (new Set(s.rules.map((r) => r.k)).size !== s.rules.length) throw new XodoError("Dois critérios com a mesma chave.", 400);
  await sql.query(`update agencies set lead_scoring = $2::jsonb where id = $1`, [agencyId, json(s)]);
  return s;
}

/** Marca à mão quais critérios manuais o negócio atende. */
export async function setDealFlags(sql: Sql, agencyId: string, dealId: string, flags: string[]) {
  const list = z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/i)).max(50).parse(flags);
  const r = await one(sql, `update deals set score_flags = $3 where id = $1 and agency_id = $2 returning id`, [dealId, agencyId, list]);
  if (!r) throw new XodoError("Negócio não encontrado.", 404);
}
