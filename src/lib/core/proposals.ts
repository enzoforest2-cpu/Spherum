import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { dayIn } from "../xodos/budget";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import { createClient } from "./clients";
import { createContract } from "./contracts";
import { winDeal } from "./crm";

/**
 * Propostas comerciais. O editor da tela guarda o documento inteiro em doc (itens, condições,
 * aparência, aditivos); aqui ficam o status, o link público, as visualizações e o aceite.
 * Aceitar cria o cliente e o contrato: pelo CRM quando a proposta veio de um negócio, senão direto.
 */

const text = (max: number) => z.string().trim().max(max);
const cents = z.number().int().min(0).max(100_000_000);

export const proposalInput = z.object({
  company: z.string().trim().min(1).max(160),
  contact_name: text(120).nullable().optional(),
  email: z.email().trim().toLowerCase().max(254).nullable().optional().or(z.literal("").transform(() => null)),
  phone: text(40).nullable().optional(),
  source: text(40).nullable().optional(),
  deal_id: z.uuid().nullable().optional(),
  client_id: z.uuid().nullable().optional(),
  doc: z.record(z.string(), z.unknown()).default({}),
  monthly_cents: cents.default(0),
  one_time_cents: cents.default(0),
  term_months: z.number().int().min(1).max(60).default(6),
});
export const proposalPatch = proposalInput.partial();

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

async function proposalOf(sql: Sql, agencyId: string, id: string) {
  const p = await one<{ id: string; status: string; company: string; contact_name: string | null; email: string | null; phone: string | null; deal_id: string | null; client_id: string | null; monthly_cents: number; one_time_cents: number; term_months: number; number: number; doc: Record<string, unknown> }>(
    sql,
    `select id, status, company, contact_name, email, phone, deal_id, client_id, monthly_cents::float8 as monthly_cents, one_time_cents::float8 as one_time_cents, term_months, number, doc
       from proposals where id = $1 and agency_id = $2`,
    [id, agencyId],
  );
  if (!p) throw new XodoError("Proposta não encontrada.", 404);
  return p;
}

async function checkRefs(sql: Sql, agencyId: string, input: { deal_id?: string | null; client_id?: string | null }) {
  if (input.deal_id && !(await one(sql, `select 1 from deals where id = $1 and agency_id = $2`, [input.deal_id, agencyId]))) throw new XodoError("Negócio não encontrado.", 404);
  if (input.client_id && !(await one(sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [input.client_id, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
}

export async function createProposal(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = proposalInput.parse(raw);
  await checkRefs(sql, agencyId, input);
  // O número é o maior + 1; duas propostas criadas ao mesmo tempo colidem na chave única, e a segunda tenta de novo.
  let row: { id: string; number: number } | null = null;
  for (let attempt = 0; attempt < 3 && !row; attempt++) {
    try {
      row = await one<{ id: string; number: number }>(
        sql,
        `insert into proposals (agency_id, number, company, contact_name, email, phone, source, deal_id, client_id, doc, monthly_cents, one_time_cents, term_months, created_by)
         values ($1, coalesce((select max(number) + 1 from proposals where agency_id = $1), 1), $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13) returning id, number`,
        [agencyId, input.company, input.contact_name ?? null, input.email ?? null, input.phone ?? null, input.source ?? null, input.deal_id ?? null, input.client_id ?? null,
          json(input.doc), input.monthly_cents, input.one_time_cents, input.term_months, userId],
      );
    } catch (error) {
      if (attempt === 2 || (error as { code?: string }).code !== "23505") throw error;
    }
  }
  // Proposta de um negócio leva o funil para "proposta".
  if (input.deal_id) await sql.query(`update deals set stage = 'proposta', stage_changed_at = now() where id = $1 and stage in ('novo', 'contato', 'diagnostico')`, [input.deal_id]);
  return row!;
}

/** Edita a proposta (o editor salva sozinho). Aceita ou recusada não muda mais, só os aditivos no doc. */
export async function updateProposal(sql: Sql, agencyId: string, id: string, raw: unknown) {
  const input = proposalPatch.parse(raw);
  const p = await proposalOf(sql, agencyId, id);
  await checkRefs(sql, agencyId, input);
  const closed = p.status === "aceita" || p.status === "recusada";
  const allowed = closed ? (["doc"] as const) : (Object.keys(input) as (keyof typeof input)[]);
  const sets: string[] = [], vals: unknown[] = [id, agencyId];
  for (const k of allowed) {
    const v = input[k];
    if (v === undefined) continue;
    vals.push(k === "doc" ? json(v) : v);
    sets.push(`${k} = $${vals.length}${k === "doc" ? "::jsonb" : ""}`);
  }
  if (sets.length) await sql.query(`update proposals set ${sets.join(", ")} where id = $1 and agency_id = $2`, vals);
}

/** Envia: gera o link público (um token novo a cada envio) e marca a validade. Devolve o token. */
export async function sendProposal(sql: Sql, agencyId: string, userId: string, id: string, validDays: number, now = new Date()) {
  const p = await proposalOf(sql, agencyId, id);
  if (p.status === "aceita") throw new XodoError("Essa proposta já foi aceita.", 409);
  const days = Math.max(1, Math.min(90, Math.round(validDays)));
  const token = randomBytes(24).toString("base64url");
  const valid = new Date(now.getTime() + days * 864e5).toISOString().slice(0, 10);
  await sql.query(
    `update proposals set status = 'enviada', token_hash = $2, sent_at = $3, valid_until = $4, declined_at = null, decline_reason = null where id = $1`,
    [id, hash(token), now.toISOString(), valid],
  );
  if (p.deal_id) await sql.query(`update deals set stage = 'proposta', stage_changed_at = now(), last_contact_at = now() where id = $1 and stage in ('novo', 'contato', 'diagnostico')`, [p.deal_id]);
  await audit(sql, { agencyId, actor: userId, action: "proposta_enviada", targetType: "proposal", targetId: id });
  return { token, valid_until: valid, email: p.email, company: p.company, contact_name: p.contact_name };
}

export async function deleteProposal(sql: Sql, agencyId: string, userId: string, id: string) {
  const p = await proposalOf(sql, agencyId, id);
  if (p.status === "aceita") throw new XodoError("Proposta aceita não pode ser apagada: ela é o registro do aceite.", 409);
  await sql.query(`delete from proposals where id = $1`, [id]);
  await audit(sql, { agencyId, actor: userId, action: "proposta_excluida", targetType: "proposal", targetId: id });
}

export async function setCatalog(sql: Sql, agencyId: string, raw: unknown) {
  const catalog = z.array(z.record(z.string(), z.unknown())).max(100).parse(raw);
  await sql.query(`update agencies set proposal_catalog = $2::jsonb where id = $1`, [agencyId, json(catalog)]);
}

export async function listProposals(sql: Sql, agencyId: string, now = new Date()) {
  const today = dayIn("America/Sao_Paulo", now);
  const [rows, cat] = await Promise.all([
    sql.query<{ id: string; number: number; deal_id: string | null; client_id: string | null; company: string; contact_name: string | null; email: string | null; phone: string | null; source: string | null; status: string; doc: Record<string, unknown>;
      monthly_cents: number; one_time_cents: number; term_months: number; valid_until: string | null; sent_at: string | null; views: number; first_viewed_at: string | null; last_viewed_at: string | null;
      accepted_at: string | null; accepted_name: string | null; accepted_email: string | null; declined_at: string | null; decline_reason: string | null; contract_id: string | null; created_at: string }>(
      `select id, number, deal_id, client_id, company, contact_name, email, phone, source, status, doc, monthly_cents::float8 as monthly_cents, one_time_cents::float8 as one_time_cents, term_months,
              valid_until::text, sent_at::text, views, first_viewed_at::text, last_viewed_at::text, accepted_at::text, accepted_name, accepted_email, declined_at::text, decline_reason, contract_id, created_at::text
         from proposals where agency_id = $1 order by created_at desc limit 300`,
      [agencyId],
    ),
    one<{ proposal_catalog: unknown }>(sql, `select proposal_catalog from agencies where id = $1`, [agencyId]),
  ]);
  const since = now.getTime() - 90 * 864e5;
  const closed = rows.filter((r) => (r.accepted_at && Date.parse(r.accepted_at) > since) || (r.declined_at && Date.parse(r.declined_at) > since));
  const acc = closed.filter((r) => r.accepted_at);
  return {
    catalog: cat?.proposal_catalog ?? null,
    proposals: rows.map((r) => ({ ...r, number_label: `P-${String(r.number).padStart(4, "0")}`, expired: r.status === "enviada" && !!r.valid_until && r.valid_until < today })),
    stats: {
      accept_rate: closed.length ? Math.round((acc.length / closed.length) * 100) : null,
      days_to_accept: acc.length ? Math.round((acc.reduce((t, r) => t + (Date.parse(r.accepted_at!) - Date.parse(r.sent_at ?? r.created_at)) / 864e5, 0) / acc.length) * 10) / 10 : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Link público (o cliente vê e aceita sem login)
// ---------------------------------------------------------------------------

async function byToken(sql: Sql, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  return one<{ id: string; agency_id: string; agency_name: string; brand_color: string | null; number: number; company: string; contact_name: string | null; email: string | null; status: string; doc: Record<string, unknown>;
    monthly_cents: number; one_time_cents: number; term_months: number; valid_until: string | null; deal_id: string | null; client_id: string | null; accepted_at: string | null; accepted_name: string | null; created_by: string | null }>(
    sql,
    `select p.id, p.agency_id, a.name as agency_name, a.brand_color, p.number, p.company, p.contact_name, p.email, p.status, p.doc, p.monthly_cents::float8 as monthly_cents, p.one_time_cents::float8 as one_time_cents,
            p.term_months, p.valid_until::text, p.deal_id, p.client_id, p.accepted_at::text, p.accepted_name, p.created_by
       from proposals p join agencies a on a.id = p.agency_id where p.token_hash = $1`,
    [hash(token)],
  );
}

/** O que o cliente vê pelo link (e conta a visualização, se ainda está aberta). */
export async function viewProposal(sql: Sql, token: string, now = new Date(), count = true) {
  const p = await byToken(sql, token);
  if (!p) throw new XodoError("Proposta não encontrada. Peça um link novo para a agência.", 404);
  const expired = p.status === "enviada" && !!p.valid_until && p.valid_until < dayIn("America/Sao_Paulo", now);
  if (count && p.status === "enviada") {
    await sql.query(`update proposals set views = views + 1, first_viewed_at = coalesce(first_viewed_at, $2), last_viewed_at = $2 where id = $1`, [p.id, now.toISOString()]);
    if ((await one<{ views: number }>(sql, `select views from proposals where id = $1`, [p.id]))?.views === 1) {
      await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'proposta_vista', $2, $3::jsonb)`, [p.agency_id, `${p.company} abriu a proposta`, json({ proposal_id: p.id })]);
    }
  }
  return {
    agency: { name: p.agency_name, color: p.brand_color }, number: `P-${String(p.number).padStart(4, "0")}`, company: p.company, contact_name: p.contact_name,
    status: expired ? "vencida" : p.status, doc: p.doc, monthly_cents: p.monthly_cents, one_time_cents: p.one_time_cents, term_months: p.term_months, valid_until: p.valid_until,
    accepted_at: p.accepted_at, accepted_name: p.accepted_name,
  };
}

/** Soma meses a uma data AAAA-MM-DD sem o estouro do JavaScript (31/01 + 1 mês = 28/02, não 03/03). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const yy = Math.floor(total / 12), mm = total % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export const acceptInput = z.object({ name: z.string().trim().min(3).max(120), email: z.email().trim().toLowerCase().max(254), agree: z.literal(true) });

/** Aceite: grava quem, quando e de onde; cria o cliente e o contrato. */
export async function acceptProposal(sql: Sql, token: string, raw: unknown, ip: string | null, now = new Date()) {
  const input = acceptInput.parse(raw);
  const p = await byToken(sql, token);
  if (!p) throw new XodoError("Proposta não encontrada.", 404);
  if (p.status === "aceita") throw new XodoError("Essa proposta já foi aceita.", 409);
  if (p.status !== "enviada") throw new XodoError("Essa proposta não está mais aberta. Fale com a agência.", 409);
  if (p.valid_until && p.valid_until < dayIn("America/Sao_Paulo", now)) throw new XodoError("A validade da proposta acabou. Peça uma nova para a agência.", 409);
  const actor = p.created_by ?? (await one<{ user_id: string }>(sql, `select user_id from agency_members where agency_id = $1 and role = 'owner' limit 1`, [p.agency_id]))!.user_id;
  const monthly = p.monthly_cents / 100;
  const payDay = Math.min(28, Math.max(1, Number((p.doc as { payDay?: number }).payDay) || 10));
  // Tudo numa transação, com a proposta travada: dois cliques (ou uma falha no meio) não deixam cliente sem proposta aceita.
  const { clientId, contractId } = await sql.transaction(async (tx) => {
    const locked = await one<{ status: string }>(tx, `select status from proposals where id = $1 for update`, [p.id]);
    if (locked?.status !== "enviada") throw new XodoError("Essa proposta já foi aceita.", 409);
    let clientId = p.client_id, contractId: string | null = null;
    const deal = p.deal_id ? await one<{ stage: string; client_id: string | null }>(tx, `select stage, client_id from deals where id = $1`, [p.deal_id]) : null;
    if (deal && deal.stage !== "ganho") {
      // Valor do negócio passa a ser o da proposta; o ganho cria cliente, onboarding e contrato.
      await tx.query(`update deals set value_cents = $2 where id = $1`, [p.deal_id, p.monthly_cents]);
      const won = await winDeal(tx, p.agency_id, actor, p.deal_id!, { contract: monthly >= 1, onboarding: true, billing_day: payDay }, now);
      clientId = won.client_id;
      contractId = won.contract_id;
    } else {
      // Negócio já fechado à mão no CRM: o cliente é o dele, não um segundo com o mesmo nome.
      if (!clientId && deal?.client_id) clientId = deal.client_id;
      if (!clientId) {
        clientId = (await createClient(tx, p.agency_id, actor, { name: p.company, status: "onboarding", monthly_fee: monthly || null, started_on: dayIn("America/Sao_Paulo", now) })).id;
        if (p.contact_name) {
          await tx.query(`insert into client_contacts (agency_id, client_id, name, email, is_primary) values ($1, $2, $3, $4, true)`, [p.agency_id, clientId, p.contact_name, p.email ?? input.email]);
        }
      }
      const open = await one(tx, `select 1 from client_contracts where client_id = $1 and status <> 'encerrado'`, [clientId]);
      if (!open && monthly >= 1) {
        const start = dayIn("America/Sao_Paulo", now);
        contractId = (await createContract(tx, p.agency_id, actor, { client_id: clientId, monthly_fee: monthly, start_date: start, end_date: addMonths(start, p.term_months), billing: "nova", billing_day: payDay }, now)).id;
      }
    }
    await tx.query(
      `update proposals set status = 'aceita', accepted_at = $2, accepted_name = $3, accepted_email = $4, accepted_ip = $5, client_id = $6, contract_id = $7 where id = $1`,
      [p.id, now.toISOString(), input.name, input.email, ip, clientId, contractId],
    );
    return { clientId, contractId };
  });
  await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'proposta_aceita', $2, $3::jsonb)`, [p.agency_id, `${p.company} aceitou a proposta`, json({ proposal_id: p.id, client_id: clientId })]);
  await audit(sql, { agencyId: p.agency_id, actor: null, action: "proposta_aceita", targetType: "proposal", targetId: p.id, summary: `aceite de ${input.name}` });
  return { client_id: clientId, contract_id: contractId };
}

export async function declineProposal(sql: Sql, token: string, reason: string | undefined, now = new Date()) {
  const p = await byToken(sql, token);
  if (!p) throw new XodoError("Proposta não encontrada.", 404);
  if (p.status !== "enviada") throw new XodoError("Essa proposta não está mais aberta.", 409);
  const why = (reason ?? "").trim().slice(0, 500) || null;
  await sql.query(`update proposals set status = 'recusada', declined_at = $2, decline_reason = $3 where id = $1`, [p.id, now.toISOString(), why]);
  await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'proposta_recusada', $2, $3::jsonb)`, [p.agency_id, `${p.company} recusou a proposta`, json({ proposal_id: p.id, reason: why })]);
}
