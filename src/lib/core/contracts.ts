import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";

/**
 * Contratos com os clientes: mensalidade, vigência, renovação com reajuste, pausa e aviso prévio.
 * O contrato manda na mensalidade automática ligada a ele. Quem aplica a regra na hora de gerar a
 * fatura é o agendador da cobrança (billingSweep); aqui ficam as mudanças feitas pela equipe.
 */

export const PAUSE_BILLING = ["suspender", "metade", "manter"] as const;
const date = z.iso.date();
const money = z.number().min(0).max(1_000_000);

export const contractInput = z.object({
  client_id: z.uuid(),
  monthly_fee: money,
  start_date: date,
  end_date: date,
  // nova: cria a mensalidade automática; existente: usa a que o cliente já tem; nenhuma: sem cobrança automática.
  billing: z.enum(["nova", "existente", "nenhuma"]).default("nova"),
  billing_day: z.number().int().min(1).max(28).optional(),
  document_id: z.uuid().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const renewInput = z.object({ end_date: date, adjust_percent: z.number().min(0).max(30).default(0) });
export const pauseInput = z.object({ from: date, to: date, reason: z.string().trim().min(1).max(200), billing: z.enum(PAUSE_BILLING) });
export const noticeInput = z.object({ notice_end: date, reason: z.string().trim().max(500).optional() });
export const contractPatch = z.object({ monthly_fee: money.optional(), document_id: z.uuid().nullable().optional(), notes: z.string().trim().max(2000).nullable().optional() });

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const cents = (v: number) => Math.round(v * 100);

async function agencyToday(sql: Sql, agencyId: string, now = new Date()) {
  const a = await one<{ timezone: string | null }>(sql, `select timezone from agencies where id = $1`, [agencyId]);
  return now.toLocaleDateString("en-CA", { timeZone: a?.timezone || "America/Sao_Paulo" });
}

/** Primeiro dia de cobrança (no dia do mês escolhido) a partir de uma data. */
export function firstBillingDate(from: string, day: number) {
  const [y, m, d] = from.split("-").map(Number);
  const pick = d <= day ? new Date(Date.UTC(y, m - 1, day)) : new Date(Date.UTC(y, m, day));
  return pick.toISOString().slice(0, 10);
}

type ContractRow = {
  id: string; client_id: string; status: string; monthly_fee_cents: number; start_date: string; end_date: string;
  pause_from: string | null; pause_to: string | null; recurrence_id: string | null; notice_end: string | null;
};

async function contractOf(sql: Sql, agencyId: string, id: string) {
  const c = await one<ContractRow>(
    sql,
    `select id, client_id, status, monthly_fee_cents::float8 as monthly_fee_cents, start_date::text, end_date::text, pause_from::text, pause_to::text, recurrence_id, notice_end::text
       from client_contracts where id = $1 and agency_id = $2`,
    [id, agencyId],
  );
  if (!c) throw new XodoError("Contrato não encontrado.", 404);
  return c;
}

const open = (c: ContractRow) => {
  if (c.status === "encerrado") throw new XodoError("Esse contrato já foi encerrado.", 409);
};

async function setRecurrenceAmount(sql: Sql, recurrenceId: string | null, amountCents: number) {
  if (!recurrenceId) return;
  // A mensalidade automática tem mínimo de R$ 1,00; contrato sem valor desliga a geração.
  if (amountCents < 100) await sql.query(`update invoice_recurrences set active = false where id = $1`, [recurrenceId]);
  else await sql.query(`update invoice_recurrences set amount_cents = $2 where id = $1`, [recurrenceId, amountCents]);
}

export async function createContract(sql: Sql, agencyId: string, userId: string, raw: unknown, now = new Date()) {
  const input = contractInput.parse(raw);
  if (input.end_date <= input.start_date) throw new XodoError("O fim da vigência vem depois do início.", 400);
  const client = await one<{ name: string }>(sql, `select name from clients where id = $1 and agency_id = $2 and archived_at is null`, [input.client_id, agencyId]);
  if (!client) throw new XodoError("Cliente não encontrado.", 404);
  const current = await one(sql, `select 1 from client_contracts where client_id = $1 and status <> 'encerrado'`, [input.client_id]);
  if (current) throw new XodoError(`${client.name} já tem um contrato em vigor. Renove ou encerre o atual.`, 409);
  if (input.document_id) {
    const doc = await one(sql, `select 1 from documents where id = $1 and agency_id = $2 and client_id = $3`, [input.document_id, agencyId, input.client_id]);
    if (!doc) throw new XodoError("Documento não encontrado neste cliente.", 404);
  }
  const fee = cents(input.monthly_fee);
  let recurrenceId: string | null = null;
  if (input.billing === "existente") {
    const rec = await one<{ id: string }>(
      sql,
      `select id from invoice_recurrences where client_id = $1 and agency_id = $2 and active order by created_at desc limit 1`,
      [input.client_id, agencyId],
    );
    if (!rec) throw new XodoError("Esse cliente não tem mensalidade automática. Escolha criar uma.", 400);
    recurrenceId = rec.id;
    await setRecurrenceAmount(sql, recurrenceId, fee);
  } else if (input.billing === "nova") {
    if (fee < 100) throw new XodoError("A mensalidade automática precisa ser de pelo menos R$ 1,00.", 400);
    const day = input.billing_day ?? Math.min(28, Number(input.start_date.slice(8, 10)));
    const today = await agencyToday(sql, agencyId, now);
    const from = input.start_date > today ? input.start_date : today;
    recurrenceId = (await one<{ id: string }>(
      sql,
      `insert into invoice_recurrences (agency_id, client_id, description, amount_cents, day_of_month, next_due, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [agencyId, input.client_id, `Mensalidade · ${client.name}`.slice(0, 200), fee, day, firstBillingDate(from, day), userId],
    ))!.id;
  }
  const row = await one<{ id: string }>(
    sql,
    `insert into client_contracts (agency_id, client_id, monthly_fee_cents, start_date, end_date, recurrence_id, document_id, notes, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [agencyId, input.client_id, fee, input.start_date, input.end_date, recurrenceId, input.document_id ?? null, input.notes ?? null, userId],
  );
  await audit(sql, { agencyId, actor: userId, action: "contrato_criado", targetType: "contract", targetId: row!.id });
  return { id: row!.id, recurrence_id: recurrenceId };
}

export async function renewContract(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown) {
  const input = renewInput.parse(raw);
  const c = await contractOf(sql, agencyId, id);
  open(c);
  if (input.end_date <= c.end_date) throw new XodoError("A nova data de fim vem depois da atual.", 400);
  const fee = Math.round(c.monthly_fee_cents * (1 + input.adjust_percent / 100));
  // Renovar também desfaz o aviso prévio.
  await sql.query(
    `update client_contracts set end_date = $3, monthly_fee_cents = $4, status = 'ativo', notice_end = null, notice_reason = null where id = $1 and agency_id = $2`,
    [id, agencyId, input.end_date, fee],
  );
  await setRecurrenceAmount(sql, c.recurrence_id, fee);
  // A mensalidade volta a valer com a renovação, inclusive se tinha sido desligada por valor abaixo do mínimo.
  if (c.recurrence_id && fee >= 100) await sql.query(`update invoice_recurrences set active = true where id = $1 and not active`, [c.recurrence_id]);
  await audit(sql, { agencyId, actor: userId, action: "contrato_renovado", targetType: "contract", targetId: id, summary: `até ${input.end_date} · reajuste de ${input.adjust_percent}%` });
  return { monthly_fee_cents: fee };
}

export async function pauseContract(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown, now = new Date()) {
  const input = pauseInput.parse(raw);
  const c = await contractOf(sql, agencyId, id);
  open(c);
  const length = days(input.from, input.to);
  if (length <= 0) throw new XodoError("A volta vem depois do início da pausa.", 400);
  if (length > 90) throw new XodoError("Pausas vão até 90 dias. Acima disso, encerre o contrato.", 400);
  if (input.to <= (await agencyToday(sql, agencyId, now))) throw new XodoError("A volta precisa ser depois de hoje.", 400);
  if (input.to > c.end_date) throw new XodoError("A pausa não pode passar do fim do contrato. Renove antes ou encerre.", 400);
  await sql.query(
    `update client_contracts set pause_from = $3, pause_to = $4, pause_reason = $5, pause_billing = $6 where id = $1 and agency_id = $2`,
    [id, agencyId, input.from, input.to, input.reason, input.billing],
  );
  await audit(sql, { agencyId, actor: userId, action: "contrato_pausado", targetType: "contract", targetId: id, summary: `${input.from} a ${input.to} · cobrança: ${input.billing}` });
}

export async function resumeContract(sql: Sql, agencyId: string, userId: string, id: string) {
  const c = await contractOf(sql, agencyId, id);
  if (!c.pause_from) throw new XodoError("Esse contrato não está pausado.", 409);
  await sql.query(`update client_contracts set pause_from = null, pause_to = null, pause_reason = null, pause_billing = null where id = $1`, [id]);
  await audit(sql, { agencyId, actor: userId, action: "contrato_retomado", targetType: "contract", targetId: id });
}

export async function noticeContract(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown, now = new Date()) {
  const input = noticeInput.parse(raw);
  const c = await contractOf(sql, agencyId, id);
  open(c);
  if (input.notice_end < (await agencyToday(sql, agencyId, now))) throw new XodoError("A data de saída não pode ser no passado.", 400);
  await sql.query(`update client_contracts set status = 'aviso', notice_end = $2, notice_reason = $3 where id = $1`, [id, input.notice_end, input.reason ?? null]);
  await audit(sql, { agencyId, actor: userId, action: "contrato_aviso_previo", targetType: "contract", targetId: id, summary: `saída em ${input.notice_end}` });
}

export async function cancelNotice(sql: Sql, agencyId: string, userId: string, id: string) {
  const c = await contractOf(sql, agencyId, id);
  if (c.status !== "aviso") throw new XodoError("Esse contrato não está em aviso prévio.", 409);
  await sql.query(`update client_contracts set status = 'ativo', notice_end = null, notice_reason = null where id = $1`, [id]);
  if (c.recurrence_id && c.monthly_fee_cents >= 100) await sql.query(`update invoice_recurrences set active = true where id = $1`, [c.recurrence_id]);
  await audit(sql, { agencyId, actor: userId, action: "contrato_aviso_cancelado", targetType: "contract", targetId: id });
}

export async function endContract(sql: Sql, agencyId: string, userId: string, id: string) {
  const c = await contractOf(sql, agencyId, id);
  open(c);
  await sql.query(`update client_contracts set status = 'encerrado', ended_at = now(), pause_from = null, pause_to = null, pause_reason = null, pause_billing = null where id = $1`, [id]);
  if (c.recurrence_id) await sql.query(`update invoice_recurrences set active = false where id = $1`, [c.recurrence_id]);
  await audit(sql, { agencyId, actor: userId, action: "contrato_encerrado", targetType: "contract", targetId: id });
}

export async function updateContract(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown) {
  const input = contractPatch.parse(raw);
  const c = await contractOf(sql, agencyId, id);
  open(c);
  if (input.document_id) {
    const doc = await one(sql, `select 1 from documents where id = $1 and agency_id = $2 and client_id = $3`, [input.document_id, agencyId, c.client_id]);
    if (!doc) throw new XodoError("Documento não encontrado neste cliente.", 404);
  }
  const fee = input.monthly_fee === undefined ? null : cents(input.monthly_fee);
  await sql.query(
    `update client_contracts set monthly_fee_cents = coalesce($3, monthly_fee_cents),
            document_id = case when $4 then $5 else document_id end, notes = case when $6 then $7 else notes end
      where id = $1 and agency_id = $2`,
    [id, agencyId, fee, input.document_id !== undefined, input.document_id ?? null, input.notes !== undefined, input.notes ?? null],
  );
  if (fee !== null) {
    await setRecurrenceAmount(sql, c.recurrence_id, fee);
    if (c.recurrence_id && fee >= 100) await sql.query(`update invoice_recurrences set active = true where id = $1 and not active`, [c.recurrence_id]);
  }
  await audit(sql, { agencyId, actor: userId, action: "contrato_editado", targetType: "contract", targetId: id });
}

/** Contratos da agência com a situação de hoje e o valor que a mensalidade cobra agora. */
export async function listContracts(sql: Sql, agencyId: string, now = new Date()) {
  const today = await agencyToday(sql, agencyId, now);
  const rows = await sql.query<{
    id: string; client_id: string; client_name: string; monthly_fee_cents: number; start_date: string; end_date: string; status: string;
    pause_from: string | null; pause_to: string | null; pause_reason: string | null; pause_billing: string | null; notice_end: string | null; notice_reason: string | null;
    ended_at: string | null; recurrence_id: string | null; recurrence_active: boolean | null; recurrence_day: number | null; recurrence_next: string | null;
    document_id: string | null; document_name: string | null; notes: string | null; created_at: string;
  }>(
    `select k.id, k.client_id, c.name as client_name, k.monthly_fee_cents::float8 as monthly_fee_cents, k.start_date::text, k.end_date::text, k.status,
            k.pause_from::text, k.pause_to::text, k.pause_reason, k.pause_billing, k.notice_end::text, k.notice_reason, k.ended_at::text,
            k.recurrence_id, r.active as recurrence_active, r.day_of_month as recurrence_day, r.next_due::text as recurrence_next,
            k.document_id, d.name as document_name, k.notes, k.created_at::text
       from client_contracts k join clients c on c.id = k.client_id
       left join invoice_recurrences r on r.id = k.recurrence_id left join documents d on d.id = k.document_id
      where k.agency_id = $1 order by (k.status = 'encerrado'), k.end_date`,
    [agencyId],
  );
  return rows.map((k) => {
    const paused = !!k.pause_from && k.pause_from <= today && today < k.pause_to!;
    const pauseSoon = !!k.pause_from && k.pause_from > today;
    const toEnd = days(today, k.end_date);
    const state = k.status === "encerrado" ? "encerrado" : k.status === "aviso" ? "aviso" : paused ? "pausado" : toEnd < 0 ? "vencido" : toEnd <= 60 ? "renova" : "ativo";
    const fee = k.monthly_fee_cents;
    const feeNow = paused ? (k.pause_billing === "suspender" ? 0 : k.pause_billing === "metade" ? Math.round(fee / 2) : fee) : k.status === "encerrado" ? 0 : fee;
    return { ...k, state, days_to_end: toEnd, pause_scheduled: pauseSoon, fee_now_cents: feeNow };
  });
}

/** Cliente com contrato pausado hoje: os xodós não mexem nas campanhas nem no portal dele. */
export async function pausedContract(sql: Sql, clientId: string, now = new Date()) {
  const row = await one<{ pause_from: string; pause_to: string; timezone: string | null }>(
    sql,
    `select k.pause_from::text, k.pause_to::text, a.timezone from client_contracts k join agencies a on a.id = k.agency_id
      where k.client_id = $1 and k.status <> 'encerrado' and k.pause_from is not null`,
    [clientId],
  );
  if (!row) return null;
  const today = now.toLocaleDateString("en-CA", { timeZone: row.timezone || "America/Sao_Paulo" });
  return row.pause_from <= today && today < row.pause_to ? { until: row.pause_to } : null;
}
