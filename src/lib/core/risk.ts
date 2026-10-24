import { z } from "zod";
import { dayIn } from "../xodos/budget";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/**
 * Radar de risco: cada cliente ganha pontos por sinal (fatura vencida, desempenho abaixo da meta,
 * aviso prévio, vigência vencida, chamado estourado, ajustes pedidos, NPS baixo). "Marcar como
 * resolvido" baixa o risco por 14 dias. O NPS é pedido pela agência e respondido no portal.
 */

export type RiskClient = { id: string; name: string; mrr: number; fin: string; gap: number | null };

export const SIGNALS = {
  fatura: 30, meta_muito: 25, meta: 12, aviso: 40, vigencia: 15, chamado: 10, ajustes: 10, detrator: 25, neutro: 10, sem_nps: 0,
} as const;

export async function riskBoard(sql: Sql, agencyId: string, clients: RiskClient[], now = new Date()) {
  const [contracts, late, changes, nps, actions, open] = await Promise.all([
    sql.query<{ client_id: string; status: string; end_date: string; notice_end: string | null }>(
      `select client_id, status, end_date::text, notice_end::text from client_contracts where agency_id = $1 and status <> 'encerrado'`, [agencyId]),
    sql.query<{ client_id: string; n: number }>(
      `select client_id, count(*)::int as n from tickets where agency_id = $1 and status = 'aberto' and first_response_at is null and due_at < $2::timestamptz group by client_id`, [agencyId, now.toISOString()]),
    sql.query<{ client_id: string; n: number }>(
      `select client_id, count(*)::int as n from client_approvals where agency_id = $1 and status = 'alteracoes' and decided_at > $2::timestamptz - interval '30 days' group by client_id`, [agencyId, now.toISOString()]),
    sql.query<{ client_id: string; score: number; comment: string | null; created_at: string }>(
      `select distinct on (client_id) client_id, score, comment, created_at::text from nps_responses where agency_id = $1 order by client_id, created_at desc`, [agencyId]),
    sql.query<{ client_id: string; created_at: string; note: string | null }>(
      `select distinct on (client_id) client_id, created_at::text, note from risk_actions where agency_id = $1 order by client_id, created_at desc`, [agencyId]),
    sql.query<{ client_id: string; requested_at: string }>(`select client_id, requested_at::text from nps_requests where agency_id = $1 and answered_at is null`, [agencyId]),
  ]);
  const today = dayIn("America/Sao_Paulo", now);
  const by = <T extends { client_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.client_id, r]));
  const K = by(contracts), L = by(late), C = by(changes), N = by(nps), A = by(actions), O = by(open);
  const rows = clients.map((c) => {
    const sig: { k: keyof typeof SIGNALS; l: string }[] = [];
    if (c.fin === "Vencida") sig.push({ k: "fatura", l: "fatura vencida" });
    if (c.gap !== null && c.gap > 25) sig.push({ k: "meta_muito", l: `${Math.round(c.gap)}% pior que a meta` });
    else if (c.gap !== null && c.gap > 10) sig.push({ k: "meta", l: `${Math.round(c.gap)}% pior que a meta` });
    const k = K.get(c.id);
    if (k?.status === "aviso") sig.push({ k: "aviso", l: `aviso prévio até ${k.notice_end!.split("-").reverse().slice(0, 2).join("/")}` });
    else if (k && k.end_date < today) sig.push({ k: "vigencia", l: "vigência do contrato vencida" });
    const t = L.get(c.id);
    if (t) sig.push({ k: "chamado", l: t.n === 1 ? "chamado fora do prazo" : `${t.n} chamados fora do prazo` });
    const ch = C.get(c.id);
    if (ch) sig.push({ k: "ajustes", l: ch.n === 1 ? "pediu ajustes numa aprovação" : `pediu ajustes em ${ch.n} aprovações` });
    const n = N.get(c.id);
    if (n && n.score <= 6) sig.push({ k: "detrator", l: `NPS ${n.score}` });
    else if (n && n.score <= 8) sig.push({ k: "neutro", l: `NPS ${n.score}` });
    const raw = Math.min(100, sig.reduce((s, x) => s + SIGNALS[x.k] * (x.k === "chamado" ? Math.min(2, L.get(c.id)!.n) : 1), 0));
    const act = A.get(c.id), recent = act && now.getTime() - Date.parse(act.created_at) < 14 * 864e5;
    const score = recent ? Math.round(raw * 0.55) : raw;
    return { client_id: c.id, name: c.name, mrr: c.mrr, score, level: score >= 60 ? "alto" : score >= 30 ? "medio" : "baixo", signals: sig.map((x) => x.l),
      nps: n ? { score: n.score, comment: n.comment, at: n.created_at } : null, nps_pending: !!O.get(c.id), action: recent ? { at: act!.created_at, note: act!.note } : null };
  }).sort((a, b) => b.score - a.score);
  // A saúde do cliente (0 a 100) é o espelho do risco; fica gravada para a lista de clientes e o portal.
  if (rows.length) {
    await sql.query(
      `update clients c set health_score = v.score, health_reason = v.reason, health_updated_at = now()
         from unnest($1::uuid[], $2::int[], $3::text[]) as v(id, score, reason)
        where c.id = v.id and c.agency_id = $4 and (c.health_score is distinct from v.score or c.health_reason is distinct from v.reason)`,
      [rows.map((r) => r.client_id), rows.map((r) => 100 - r.score), rows.map((r) => (r.signals.length ? r.signals.slice(0, 3).join("; ") : "Sem sinais de risco").slice(0, 300)), agencyId],
    ).catch((error) => console.error("[risco] saúde do cliente não gravada", error));
  }
  const all = nps.filter((n) => clients.some((c) => c.id === n.client_id));
  const prom = all.filter((n) => n.score >= 9).length, det = all.filter((n) => n.score <= 6).length;
  return {
    rows,
    nps: { answered: all.length, promoters: prom, detractors: det, neutrals: all.length - prom - det, score: all.length ? Math.round(((prom - det) / all.length) * 100) : null, last: all.map((n) => n.created_at).sort().pop() ?? null },
    revenue_at_risk: rows.filter((r) => r.level === "alto").reduce((s, r) => s + r.mrr, 0),
  };
}

export async function markRiskHandled(sql: Sql, agencyId: string, userId: string, clientId: string, note?: string) {
  if (!(await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [clientId, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
  await sql.query(`insert into risk_actions (agency_id, client_id, note, created_by) values ($1, $2, $3, $4)`, [agencyId, clientId, note?.trim().slice(0, 500) || null, userId]);
}

export const npsAsk = z.object({ client_ids: z.array(z.uuid()).min(1).max(500), question: z.string().trim().min(10).max(300) });

/** Pede o NPS: o portal de cada cliente passa a mostrar a pergunta (um pedido aberto por cliente). */
export async function requestNps(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = npsAsk.parse(raw);
  let n = 0;
  for (const id of input.client_ids) {
    if (!(await one(sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [id, agencyId]))) continue;
    await sql.query(`delete from nps_requests where client_id = $1 and answered_at is null`, [id]);
    await sql.query(`insert into nps_requests (agency_id, client_id, question, requested_by) values ($1, $2, $3, $4)`, [agencyId, id, input.question, userId]);
    n += 1;
  }
  return { requested: n };
}

/** Pergunta aberta para o portal do cliente (ou nada). */
export async function openNps(sql: Sql, clientId: string) {
  return one<{ id: string; question: string }>(sql, `select id, question from nps_requests where client_id = $1 and answered_at is null order by requested_at desc limit 1`, [clientId]);
}

export const npsAnswer = z.object({ score: z.number().int().min(0).max(10), comment: z.string().trim().max(2000).optional() });

export async function answerNps(sql: Sql, agencyId: string, clientId: string, userId: string, raw: unknown) {
  const input = npsAnswer.parse(raw);
  // Só com pergunta aberta, e cada pergunta é respondida uma vez: fecha o pedido antes de gravar (duas abas não dobram a resposta).
  const req = await one<{ id: string }>(sql,
    `update nps_requests set answered_at = now() where id = (select id from nps_requests where client_id = $1 and answered_at is null order by requested_at desc limit 1) and answered_at is null returning id`,
    [clientId]);
  if (!req) throw new XodoError("Essa pesquisa já foi respondida. Obrigado!", 409);
  await sql.query(`insert into nps_responses (agency_id, client_id, request_id, user_id, score, comment) values ($1, $2, $3, $4, $5, $6)`,
    [agencyId, clientId, req.id, userId, input.score, input.comment || null]);
  const c = await one<{ name: string }>(sql, `select name from clients where id = $1`, [clientId]);
  await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'nps', $2, $3::jsonb)`,
    [agencyId, `NPS ${input.score} de ${c?.name ?? "cliente"}`, json({ client_id: clientId, score: input.score })]);
}
