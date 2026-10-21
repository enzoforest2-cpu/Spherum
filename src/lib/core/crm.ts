import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import { createClient } from "./clients";
import { createContract } from "./contracts";
import { createProject } from "./projects";

/**
 * CRM: negócios (leads) no funil de vendas. Negócio ganho vira cliente: cria o cliente com o
 * contato, o projeto de onboarding (playbook) e, se combinado, o contrato com a mensalidade.
 */

export const STAGES = ["novo", "contato", "diagnostico", "proposta", "negociacao", "ganho", "perdido"] as const;
export const OPEN_STAGES = STAGES.slice(0, 5);
/** Chance de fechar em cada etapa aberta (para a previsão). */
export const STAGE_PROB: Record<string, number> = { novo: 0.1, contato: 0.2, diagnostico: 0.35, proposta: 0.5, negociacao: 0.7, ganho: 1, perdido: 0 };

const text = (max: number) => z.string().trim().max(max);
const date = z.iso.date();

const fields = {
  company: z.string().trim().min(1).max(160),
  contact_name: text(120).nullable(),
  email: z.email().trim().toLowerCase().max(254).nullable().or(z.literal("").transform(() => null)),
  phone: text(40).nullable(),
  segment: text(80).nullable(),
  website: text(200).nullable(),
  source: text(40).nullable(),
  value: z.number().min(0).max(1_000_000),
  stage: z.enum(OPEN_STAGES as unknown as [string, ...string[]]),
  owner_user: z.uuid().nullable(),
  next_action: text(200).nullable(),
  next_action_date: date.nullable(),
  notes: text(4000).nullable(),
};

export const dealInput = z.object(fields).partial().required({ company: true });
export const dealPatch = z.object({ ...fields, stage: z.enum(STAGES), lost_reason: text(300).nullable(), contacted: z.boolean() }).partial();

export const winInput = z.object({
  // Contrato com a mensalidade automática (dia de vencimento) a partir de hoje, por 12 meses.
  contract: z.boolean().default(true),
  billing_day: z.number().int().min(1).max(28).default(10),
  onboarding: z.boolean().default(true),
});

async function checkMember(sql: Sql, agencyId: string, userId: string | null | undefined) {
  if (!userId) return;
  const m = await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, userId]);
  if (!m) throw new XodoError("Essa pessoa não é da equipe.", 400);
}

function toRow(input: Record<string, unknown>) {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || k === "contacted") continue;
    if (k === "value") row.value_cents = Math.round((v as number) * 100);
    else row[k] = v;
  }
  return row;
}

export async function createDeal(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = dealInput.parse(raw);
  await checkMember(sql, agencyId, input.owner_user);
  const row: Record<string, unknown> = { ...toRow(input), owner_user: input.owner_user === undefined ? userId : input.owner_user };
  const keys = Object.keys(row);
  const created = await one<{ id: string }>(
    sql,
    `insert into deals (agency_id, created_by, ${keys.join(", ")}) values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(", ")}) returning id`,
    [agencyId, userId, ...keys.map((k) => row[k])],
  );
  await audit(sql, { agencyId, actor: userId, action: "negocio_criado", targetType: "deal", targetId: created!.id });
  return created!;
}

async function dealOf(sql: Sql, agencyId: string, id: string) {
  const d = await one<{ id: string; stage: string; company: string; contact_name: string | null; email: string | null; phone: string | null; segment: string | null; website: string | null; value_cents: number; owner_user: string | null; client_id: string | null }>(
    sql,
    `select id, stage, company, contact_name, email, phone, segment, website, value_cents::float8 as value_cents, owner_user, client_id from deals where id = $1 and agency_id = $2`,
    [id, agencyId],
  );
  if (!d) throw new XodoError("Negócio não encontrado.", 404);
  return d;
}

/** Edita o negócio, muda de etapa (ganho só pelo winDeal) ou registra um contato feito agora. */
export async function updateDeal(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown) {
  const input = dealPatch.parse(raw);
  const d = await dealOf(sql, agencyId, id);
  await checkMember(sql, agencyId, input.owner_user);
  if (input.stage === "ganho" && d.stage !== "ganho") throw new XodoError("Para marcar como ganho, use “Marcar como fechado”: ele cria o cliente.", 400);
  if (d.stage === "ganho" && input.stage && input.stage !== "ganho") throw new XodoError("Negócio ganho já virou cliente e não volta para o funil.", 409);
  const row = toRow(input);
  const sets = Object.keys(row).map((k, i) => `${k} = $${i + 3}`);
  if (input.stage && input.stage !== d.stage) {
    sets.push(`stage_changed_at = now()`);
    sets.push(input.stage === "perdido" ? `lost_at = now()` : `lost_at = null`);
    if (input.stage !== "perdido") sets.push(`lost_reason = null`);
  }
  if (input.contacted) sets.push(`last_contact_at = now()`);
  if (!sets.length) return;
  await sql.query(`update deals set ${sets.join(", ")} where id = $1 and agency_id = $2`, [id, agencyId, ...Object.values(row)]);
  if (input.stage && input.stage !== d.stage) {
    await audit(sql, { agencyId, actor: userId, action: `negocio_${input.stage}`, targetType: "deal", targetId: id });
  }
}

export async function deleteDeal(sql: Sql, agencyId: string, userId: string, id: string) {
  await dealOf(sql, agencyId, id);
  await sql.query(`delete from deals where id = $1 and agency_id = $2`, [id, agencyId]);
  await audit(sql, { agencyId, actor: userId, action: "negocio_excluido", targetType: "deal", targetId: id });
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

/** Negócio fechado: vira cliente, com o contato, o onboarding e o contrato com a mensalidade. */
export async function winDeal(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown, now = new Date()) {
  const input = winInput.parse(raw);
  const d = await dealOf(sql, agencyId, id);
  if (d.stage === "ganho") throw new XodoError("Esse negócio já virou cliente.", 409);
  const today = addDays(now, 0);
  const client = await createClient(sql, agencyId, userId, {
    name: d.company, segment: d.segment, website: d.website, status: "onboarding", started_on: today,
    monthly_fee: d.value_cents ? d.value_cents / 100 : null, owner_user_id: d.owner_user,
  });
  if (d.contact_name) {
    await sql.query(
      `insert into client_contacts (agency_id, client_id, name, email, phone, is_primary) values ($1, $2, $3, $4, $5, true)`,
      [agencyId, client.id, d.contact_name, d.email, d.phone],
    );
  }
  let projectId: string | null = null;
  if (input.onboarding) {
    projectId = (await createProject(sql, agencyId, userId, {
      name: `Onboarding · ${d.company}`.slice(0, 160), client_id: client.id, owner_user: d.owner_user, priority: "alta", tags: ["Onboarding"],
      start_date: today, due_date: addDays(now, 9), playbook: "onboarding",
    }, now)).id;
  }
  let contractId: string | null = null;
  if (input.contract && d.value_cents >= 100) {
    const end = new Date(now); end.setFullYear(end.getFullYear() + 1);
    contractId = (await createContract(sql, agencyId, userId, {
      client_id: client.id, monthly_fee: d.value_cents / 100, start_date: today, end_date: addDays(end, 0), billing: "nova", billing_day: input.billing_day,
    }, now)).id;
  }
  await sql.query(
    `update deals set stage = 'ganho', won_at = now(), stage_changed_at = now(), lost_at = null, lost_reason = null, client_id = $3,
            next_action = 'Convertido em cliente', next_action_date = null where id = $1 and agency_id = $2`,
    [id, agencyId, client.id],
  );
  await audit(sql, { agencyId, actor: userId, action: "negocio_ganho", targetType: "deal", targetId: id });
  return { client_id: client.id, project_id: projectId, contract_id: contractId, email: d.email };
}

/** Negócios da agência e os números do funil (previsão, taxa de fechamento e ciclo nos últimos 90 dias). */
export async function crmBoard(sql: Sql, agencyId: string, now = new Date()) {
  const deals = await sql.query<{
    id: string; company: string; contact_name: string | null; email: string | null; phone: string | null; segment: string | null; website: string | null; source: string | null;
    value_cents: number; stage: string; owner_user: string | null; owner_name: string | null; next_action: string | null; next_action_date: string | null;
    last_contact_at: string | null; stage_changed_at: string; notes: string | null; lost_reason: string | null; won_at: string | null; lost_at: string | null; client_id: string | null; created_at: string;
  }>(
    `select d.id, d.company, d.contact_name, d.email, d.phone, d.segment, d.website, d.source, d.value_cents::float8 as value_cents, d.stage,
            d.owner_user, coalesce(p.full_name, u.email) as owner_name, d.next_action, d.next_action_date::text, d.last_contact_at::text, d.stage_changed_at::text,
            d.notes, d.lost_reason, d.won_at::text, d.lost_at::text, d.client_id, d.created_at::text
       from deals d left join profiles p on p.id = d.owner_user left join auth.users u on u.id = d.owner_user
      where d.agency_id = $1 and (d.stage not in ('ganho', 'perdido') or coalesce(d.won_at, d.lost_at) > $2::timestamptz - interval '90 days')
      order by d.stage_changed_at desc`,
    [agencyId, now.toISOString()],
  );
  const since = now.getTime() - 90 * 864e5;
  const won = deals.filter((d) => d.won_at && Date.parse(d.won_at) > since);
  const lost = deals.filter((d) => d.lost_at && Date.parse(d.lost_at) > since);
  const open = deals.filter((d) => (OPEN_STAGES as readonly string[]).includes(d.stage));
  return {
    deals: deals.map((d) => ({ ...d, days_in_stage: Math.max(0, Math.floor((now.getTime() - Date.parse(d.stage_changed_at)) / 864e5)) })),
    stats: {
      pipeline_cents: open.reduce((t, d) => t + d.value_cents, 0),
      forecast_cents: Math.round(open.filter((d) => d.stage === "proposta" || d.stage === "negociacao").reduce((t, d) => t + d.value_cents * STAGE_PROB[d.stage], 0)),
      weighted_cents: Math.round(open.reduce((t, d) => t + d.value_cents * STAGE_PROB[d.stage], 0)),
      open: open.length,
      won_90d: won.length,
      lost_90d: lost.length,
      close_rate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : null,
      cycle_days: won.length ? Math.round(won.reduce((t, d) => t + (Date.parse(d.won_at!) - Date.parse(d.created_at)) / 864e5, 0) / won.length) : null,
    },
  };
}
