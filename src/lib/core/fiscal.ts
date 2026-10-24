import { randomBytes } from "node:crypto";
import { z } from "zod";
import { json, num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import type { Mailer } from "./email";

/**
 * Notas e cobranças. Cada fatura vira uma NFS-e (quando o cliente paga, no vencimento ou no dia 1º,
 * conforme a agência escolher), emitida pelo provedor (Focus NFe). Emitida, o PDF vai para o cliente
 * e o XML para a contabilidade. A régua de cobrança manda lembretes antes e depois do vencimento.
 */

const TZ = "America/Sao_Paulo";
const brl = (cents: number) => `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

export type NoteRequest = {
  ref: string; issuedOn: string;
  prestador: { cnpj: string; inscricao_municipal: string; codigo_municipio: string };
  tomador: { doc: string; name: string; email: string | null };
  servico: { aliquota: number; item_lista_servico: string; codigo_tributario_municipio: string | null; discriminacao: string; valor: number; iss_retido: boolean };
  simples: boolean;
};
export type NoteStatus = { status: "processando" | "emitida" | "erro" | "cancelada"; number?: string | null; verification_code?: string | null; pdf_url?: string | null; xml_url?: string | null; error?: string | null };
export type FiscalProvider = {
  emit(agencyId: string, connectionId: string, env: "homologacao" | "producao", req: NoteRequest): Promise<NoteStatus>;
  query(agencyId: string, connectionId: string, env: "homologacao" | "producao", ref: string): Promise<NoteStatus>;
  cancel(agencyId: string, connectionId: string, env: "homologacao" | "producao", ref: string, reason: string): Promise<NoteStatus>;
};
export type FiscalDeps = { sql: Sql; provider: FiscalProvider; mailer: Mailer };

export const configInput = z.object({
  connection_id: z.uuid().nullable(),
  environment: z.enum(["homologacao", "producao"]),
  cnpj: z.string().transform(digits).refine((s) => s.length === 14, "CNPJ da agência com 14 dígitos."),
  inscricao_municipal: z.string().trim().min(1).max(30),
  codigo_municipio: z.string().regex(/^\d{7}$/, "Código IBGE do município (7 dígitos)."),
  municipio: z.string().trim().max(80),
  item_lista_servico: z.string().trim().min(1).max(10),
  codigo_tributario_municipio: z.string().trim().max(20).nullable(),
  aliquota: z.number().min(0).max(10),
  simples: z.boolean(),
  description: z.string().trim().min(5).max(500),
  emit_when: z.enum(["pay", "due", "d1", "manual"]),
  accountant_email: z.email().nullable(),
  // Régua de cobrança: 3 dias antes, no vencimento, 3 e 7 dias depois.
  dunning: z.object({ d3: z.boolean(), d0: z.boolean(), p3: z.boolean(), p7: z.boolean() }),
}).partial();
type Config = { connection_id: string | null; environment: "homologacao" | "producao"; cnpj: string; inscricao_municipal: string; codigo_municipio: string; municipio: string; item_lista_servico: string; codigo_tributario_municipio: string | null; aliquota: number; simples: boolean; description: string; emit_when: "pay" | "due" | "d1" | "manual"; accountant_email: string | null; dunning: { d3: boolean; d0: boolean; p3: boolean; p7: boolean }; enabled_at?: string };

const DEFAULTS: Config = {
  connection_id: null, environment: "homologacao", cnpj: "", inscricao_municipal: "", codigo_municipio: "", municipio: "", item_lista_servico: "17.06",
  codigo_tributario_municipio: null, aliquota: 2, simples: true, description: "Gestão de marketing digital · {mes}", emit_when: "manual", accountant_email: null,
  dunning: { d3: true, d0: true, p3: true, p7: false },
};

export async function getConfig(sql: Sql, agencyId: string): Promise<Config> {
  const c = (await one<{ c: Partial<Config> }>(sql, `select fiscal_config as c from agencies where id = $1`, [agencyId]))?.c ?? {};
  return { ...DEFAULTS, ...c, dunning: { ...DEFAULTS.dunning, ...(c.dunning ?? {}) } };
}

export async function setConfig(sql: Sql, agencyId: string, raw: unknown, now = new Date()) {
  const i = configInput.parse(raw);
  const cur = await getConfig(sql, agencyId);
  if (i.connection_id) {
    const c = await one<{ provider: string }>(sql, `select provider from integration_connections where id = $1 and agency_id = $2 and status <> 'revoked'`, [i.connection_id, agencyId]);
    if (!c || c.provider !== "focusnfe") throw new XodoError("Escolha a conexão da Focus NFe.", 400);
  }
  const next: Config = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)), dunning: { ...cur.dunning, ...(i.dunning ?? {}) } } as Config;
  // Emissão automática vale para faturas a partir de agora (não emite o passado de uma vez).
  if (i.emit_when && i.emit_when !== "manual" && cur.emit_when !== i.emit_when) next.enabled_at = now.toISOString();
  await sql.query(`update agencies set fiscal_config = $2::jsonb where id = $1`, [agencyId, json(next)]);
  return next;
}

export async function setClientTax(sql: Sql, agencyId: string, clientId: string, raw: unknown) {
  const i = z.object({ cnpj: z.string().transform(digits).refine((s) => s.length === 11 || s.length === 14, "CPF ou CNPJ inválido.").nullable().optional(), legal_name: z.string().trim().max(200).nullable().optional(), billing_email: z.email().nullable().optional() }).parse(raw);
  const r = await one(sql, `update clients set cnpj = coalesce($3, cnpj), legal_name = coalesce($4, legal_name), billing_email = coalesce($5, billing_email) where id = $1 and agency_id = $2 returning id`,
    [clientId, agencyId, i.cnpj ?? null, i.legal_name ?? null, i.billing_email ?? null]);
  if (!r) throw new XodoError("Cliente não encontrado.", 404);
}

function ready(c: Config) {
  const missing = [!c.connection_id && "conexão da Focus NFe", !c.cnpj && "CNPJ da agência", !c.inscricao_municipal && "inscrição municipal", !c.codigo_municipio && "código do município"].filter(Boolean);
  if (missing.length) throw new XodoError(`Complete as configurações fiscais: ${missing.join(", ")}.`, 400);
}

const monthLabel = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: TZ, month: "short", year: "2-digit" }).replace(/\./g, "").replace(" de ", "/");

/** Cria a nota de uma fatura e manda ao provedor. */
export async function emitForInvoice(deps: FiscalDeps, agencyId: string, invoiceId: string, userId: string | null, now = new Date()) {
  const { sql } = deps;
  const cfg = await getConfig(sql, agencyId);
  ready(cfg);
  const inv = await one<{ id: string; client_id: string; description: string; amount_cents: number; paid_cents: number | null; status: string; due_date: string; client_name: string; cnpj: string | null; legal_name: string | null; email: string | null }>(
    sql,
    `select i.id, i.client_id, i.description, i.amount_cents::float8 as amount_cents, i.paid_cents::float8 as paid_cents, i.status, i.due_date::text, c.name as client_name, c.cnpj, c.legal_name,
            coalesce(c.billing_email, (select email from client_contacts where client_id = c.id and email is not null order by is_primary desc, created_at limit 1)) as email
       from invoices i join clients c on c.id = i.client_id where i.id = $1 and i.agency_id = $2`,
    [invoiceId, agencyId]);
  if (!inv) throw new XodoError("Fatura não encontrada.", 404);
  if (["cancelado", "estornado"].includes(inv.status)) throw new XodoError("Fatura cancelada não gera nota.", 409);
  if (await one(sql, `select 1 from fiscal_notes where invoice_id = $1 and status <> 'cancelada'`, [invoiceId])) throw new XodoError("Essa fatura já tem nota.", 409);
  const doc = digits(inv.cnpj);
  if (doc.length !== 11 && doc.length !== 14) throw new XodoError(`Falta o CPF ou CNPJ de ${inv.client_name} para emitir a nota.`, 400);
  const amount = num(inv.paid_cents ?? inv.amount_cents);
  const description = cfg.description.replace("{mes}", monthLabel(new Date(`${inv.due_date}T12:00:00-03:00`))).replace("{fatura}", inv.description).slice(0, 2000);
  const ref = `sp${randomBytes(9).toString("hex")}`;
  const note = (await one<{ id: string }>(
    sql,
    `insert into fiscal_notes (agency_id, client_id, invoice_id, ref, status, amount_cents, description, created_by) values ($1, $2, $3, $4, 'processando', $5, $6, $7) returning id`,
    [agencyId, inv.client_id, inv.id, ref, amount, description, userId],
  ))!;
  let st: NoteStatus;
  try {
    st = await deps.provider.emit(agencyId, cfg.connection_id!, cfg.environment, {
      ref, issuedOn: now.toISOString(),
      prestador: { cnpj: cfg.cnpj, inscricao_municipal: cfg.inscricao_municipal, codigo_municipio: cfg.codigo_municipio },
      tomador: { doc, name: inv.legal_name || inv.client_name, email: inv.email },
      servico: { aliquota: cfg.aliquota, item_lista_servico: cfg.item_lista_servico, codigo_tributario_municipio: cfg.codigo_tributario_municipio, discriminacao: description, valor: amount / 100, iss_retido: false },
      simples: cfg.simples,
    });
  } catch (error) {
    // Falha de rede ou do provedor (502): a Focus pode ter recebido a nota. Fica processando, e o cron consulta pela referência.
    const transport = error instanceof XodoError && error.status === 502;
    st = { status: transport ? "processando" : "erro", error: error instanceof Error ? error.message : String(error) };
  }
  await applyStatus(deps, note.id, st, now);
  return { id: note.id, status: st.status, error: st.error ?? null };
}

/** Grava o que o provedor disse; ao emitir, manda o PDF ao cliente e o XML à contabilidade. */
async function applyStatus(deps: FiscalDeps, noteId: string, st: NoteStatus, now: Date) {
  const { sql } = deps;
  const n = await one<{ id: string; agency_id: string; status: string; client_id: string; amount_cents: number; sent_at: string | null }>(sql, `select id, agency_id, status, client_id, amount_cents::float8 as amount_cents, sent_at::text from fiscal_notes where id = $1`, [noteId]);
  if (!n) return;
  await sql.query(
    `update fiscal_notes set status = $2, number = coalesce($3, number), verification_code = coalesce($4, verification_code), pdf_url = coalesce($5, pdf_url), xml_url = coalesce($6, xml_url),
            error = $7, issued_at = case when $2 = 'emitida' then coalesce(issued_at, $8::timestamptz) else issued_at end where id = $1`,
    [noteId, st.status, st.number ?? null, st.verification_code ?? null, st.pdf_url ?? null, st.xml_url ?? null, st.status === "erro" ? (st.error ?? "Erro no provedor").slice(0, 1000) : st.status === "processando" && st.error ? st.error.slice(0, 1000) : null, now.toISOString()],
  );
  if (st.status === "erro" && n.status !== "erro") {
    await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'nota_com_erro', $2, jsonb_build_object('note_id', $3::text))`, [n.agency_id, `Nota fiscal com erro: ${(st.error ?? "").slice(0, 120)}`.slice(0, 200), noteId]);
  }
  if (st.status === "emitida" && !n.sent_at) {
    const info = await one<{ client_name: string; email: string | null; agency_name: string }>(
      sql,
      `select c.name as client_name, a.name as agency_name, coalesce(c.billing_email, (select email from client_contacts where client_id = c.id and email is not null order by is_primary desc, created_at limit 1)) as email
         from clients c join agencies a on a.id = c.agency_id where c.id = $1`, [n.client_id]);
    const cfg = await getConfig(sql, n.agency_id);
    // Em homologação a nota é de teste: ninguém de fora recebe.
    const real = cfg.environment === "producao";
    if (real && info?.email && st.pdf_url) await deps.mailer({ to: info.email, subject: `Nota fiscal ${st.number ?? ""} · ${info.agency_name}`.trim(), text: `Olá! Segue a nota fiscal de ${brl(n.amount_cents)}.\n\nNota: ${st.pdf_url}\n\n${info.agency_name}` }).catch(() => false);
    if (real && cfg.accountant_email && st.xml_url) await deps.mailer({ to: cfg.accountant_email, subject: `XML da NFS-e ${st.number ?? ""} · ${info?.client_name ?? ""}`.trim(), text: `XML: ${st.xml_url}\nPDF: ${st.pdf_url ?? "-"}\nValor: ${brl(n.amount_cents)}` }).catch(() => false);
    await sql.query(`update fiscal_notes set sent_at = $2 where id = $1`, [noteId, now.toISOString()]);
  }
}

export async function cancelNote(deps: FiscalDeps, agencyId: string, id: string, reason: string, now = new Date()) {
  const r = z.string().trim().min(15, "Explique o motivo (mínimo de 15 caracteres, exigência da prefeitura).").max(255).parse(reason);
  const n = await one<{ ref: string; status: string }>(deps.sql, `select ref, status from fiscal_notes where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!n) throw new XodoError("Nota não encontrada.", 404);
  const cfg = await getConfig(deps.sql, agencyId);
  if (n.status === "erro" || n.status === "pendente") {
    // Antes de dar como cancelada só aqui, confere se a prefeitura não autorizou (um erro de rede pode ter sido depois do envio).
    if (cfg.connection_id) {
      let remote: NoteStatus | null = null;
      try { remote = await deps.provider.query(agencyId, cfg.connection_id, cfg.environment, n.ref); } catch { remote = null; }
      if (remote?.status === "emitida") { await applyStatus(deps, id, remote, now); throw new XodoError("Essa nota foi autorizada pela prefeitura. Confira e cancele de novo, agora pela prefeitura.", 409); }
      if (remote?.status === "processando" && n.status === "erro") { await applyStatus(deps, id, remote, now); throw new XodoError("A prefeitura ainda está processando essa nota. Tente de novo em alguns minutos.", 409); }
    }
    await deps.sql.query(`update fiscal_notes set status = 'cancelada' where id = $1`, [id]);
    return;
  }
  if (n.status !== "emitida") throw new XodoError("A nota ainda está sendo processada.", 409);
  ready(cfg);
  const st = await deps.provider.cancel(agencyId, cfg.connection_id!, cfg.environment, n.ref, r);
  await applyStatus(deps, id, st, now);
}

/** Faturas que já deveriam ter nota, conforme a regra da agência (nota cancelada não volta sozinha: reemitir é à mão). */
async function eligible(sql: Sql, agencyId: string, cfg: Config, now: Date) {
  if (cfg.emit_when === "manual" || !cfg.enabled_at) return [];
  const today = now.toLocaleDateString("en-CA", { timeZone: TZ });
  const cond = cfg.emit_when === "pay" ? `i.status = 'pago' and i.paid_at >= $2 and i.paid_at < $3::date + 1` : cfg.emit_when === "due" ? `i.status in ('pendente', 'pago', 'vencido') and i.due_date <= $3::date and i.due_date >= ($2::timestamptz at time zone 'America/Sao_Paulo')::date`
    : `i.status in ('pendente', 'pago', 'vencido') and date_trunc('month', i.due_date) <= date_trunc('month', $3::date) and i.created_at >= $2`;
  // Fatura que falhou antes de virar nota (sem CPF/CNPJ, cadastro incompleto) espera um dia antes de nova tentativa; o aviso fica em `notifications`.
  return sql.query<{ id: string }>(
    `select i.id from invoices i where i.agency_id = $1 and ${cond} and not exists (select 1 from fiscal_notes n where n.invoice_id = i.id)
       and not exists (select 1 from notifications x where x.agency_id = i.agency_id and x.kind = 'nota_nao_emitida' and x.data->>'invoice_id' = i.id::text and x.created_at > now() - interval '1 day') limit 50`,
    [agencyId, cfg.enabled_at, today]);
}

/** Cron: emite o que a regra pede, consulta as notas em processamento e manda a régua de cobrança. */
export async function fiscalSweep(deps: FiscalDeps, now = new Date(), opts: { deadline?: number } = {}) {
  const { sql } = deps;
  const out = { emitted: 0, updated: 0, reminders: 0, errors: 0 };
  const agencies = await sql.query<{ id: string }>(`select id from agencies where fiscal_config <> '{}'::jsonb`);
  for (const a of agencies) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const cfg = await getConfig(sql, a.id);
    const left = () => !opts.deadline || Date.now() < opts.deadline - 30_000;
    if (cfg.connection_id && cfg.cnpj) {
      for (const inv of await eligible(sql, a.id, cfg, now)) {
        if (!left()) break;
        try {
          const r = await emitForInvoice(deps, a.id, inv.id, null, now);
          if (r.status === "erro") out.errors++; else out.emitted++;
        } catch (error) {
          // Não virou nota (falta CPF/CNPJ, cadastro incompleto): avisa a agência uma vez por dia e espera.
          out.errors++;
          await sql.query(`insert into notifications (agency_id, kind, title, body, data) values ($1, 'nota_nao_emitida', $2, $3, jsonb_build_object('invoice_id', $4::text))`,
            [a.id, "Nota fiscal não emitida", (error instanceof Error ? error.message : String(error)).slice(0, 300), inv.id]).catch(() => undefined);
        }
      }
      for (const n of await sql.query<{ id: string; ref: string }>(`select id, ref from fiscal_notes where agency_id = $1 and status = 'processando' order by created_at limit 50`, [a.id])) {
        if (!left()) break;
        try { await applyStatus(deps, n.id, await deps.provider.query(a.id, cfg.connection_id, cfg.environment, n.ref), now); out.updated++; } catch { out.errors++; }
      }
    }
    out.reminders += await dunning(deps, a.id, cfg, now);
  }
  return out;
}

/** Régua de cobrança: um e-mail por tipo por fatura, com o link de pagamento. */
async function dunning(deps: FiscalDeps, agencyId: string, cfg: Config, now: Date) {
  const { sql } = deps;
  const today = now.toLocaleDateString("en-CA", { timeZone: TZ });
  // Lembrete chega em horário comercial, não no primeiro ciclo depois da meia-noite.
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now)) % 24;
  if (hour < 8 || hour >= 20) return 0;
  const rules = ([["d3", 3], ["d0", 0], ["p3", -3], ["p7", -7]] as const).filter(([k]) => cfg.dunning[k]);
  let sent = 0;
  for (const [kind, offset] of rules) {
    const rows = await sql.query<{ id: string; description: string; amount_cents: number; due_date: string; payment_url: string | null; client_name: string; email: string | null; agency_name: string }>(
      `select i.id, i.description, i.amount_cents::float8 as amount_cents, i.due_date::text, i.payment_url, c.name as client_name, a.name as agency_name,
              coalesce(c.billing_email, (select email from client_contacts where client_id = c.id and email is not null order by is_primary desc, created_at limit 1)) as email
         from invoices i join clients c on c.id = i.client_id join agencies a on a.id = i.agency_id
        where i.agency_id = $1 and i.status in ('pendente', 'vencido') and i.due_date = $2::date + $3::int
          and not exists (select 1 from invoice_reminders r where r.invoice_id = i.id and r.kind = $4)`,
      [agencyId, today, offset, kind]);
    for (const r of rows) {
      const ins = await one(sql, `insert into invoice_reminders (invoice_id, agency_id, kind) values ($1, $2, $3) on conflict do nothing returning invoice_id`, [r.id, agencyId, kind]);
      if (!ins) continue;
      const due = r.due_date.split("-").reverse().join("/");
      const line = kind === "d3" ? `vence em 3 dias (${due})` : kind === "d0" ? "vence hoje" : `venceu em ${due}`;
      if (r.email) await deps.mailer({ to: r.email, subject: `${r.description}: ${brl(r.amount_cents)} ${line}`, text: `Olá! A fatura "${r.description}" de ${brl(r.amount_cents)} ${line}.${r.payment_url ? `\n\nPague pelo link: ${r.payment_url}` : ""}\n\n${r.agency_name}` }).catch(() => false);
      if (kind === "p3" || kind === "p7") {
        await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'fatura_atrasada', $2, jsonb_build_object('invoice_id', $3::text))`,
          [agencyId, `${r.client_name}: fatura de ${brl(r.amount_cents)} atrasada há ${-offset} dias`.slice(0, 200), r.id]);
      }
      sent++;
    }
  }
  return sent;
}

export async function fiscalBoard(sql: Sql, agencyId: string, now = new Date()) {
  const [config, notes, pending, clients, recurrences, overdue, connections] = await Promise.all([
    getConfig(sql, agencyId),
    sql.query<{ id: string; client_id: string; invoice_id: string | null; number: string | null; status: string; amount_cents: number; description: string; pdf_url: string | null; xml_url: string | null; error: string | null; issued_at: string | null; created_at: string }>(
      `select id, client_id, invoice_id, number, status, amount_cents::float8 as amount_cents, description, pdf_url, xml_url, error, issued_at::text, created_at::text
         from fiscal_notes where agency_id = $1 order by created_at desc limit 200`, [agencyId]),
    sql.query<{ id: string; client_id: string; description: string; amount_cents: number; status: string; due_date: string; paid_at: string | null }>(
      `select i.id, i.client_id, i.description, i.amount_cents::float8 as amount_cents, i.status, i.due_date::text, i.paid_at::text from invoices i
        where i.agency_id = $1 and i.status in ('pago', 'pendente', 'vencido') and i.due_date >= $2::date - interval '60 days'
          and not exists (select 1 from fiscal_notes n where n.invoice_id = i.id and n.status <> 'cancelada') order by i.due_date desc limit 100`,
      [agencyId, now.toISOString().slice(0, 10)]),
    sql.query<{ id: string; name: string; cnpj: string | null; legal_name: string | null; billing_email: string | null }>(`select id, name, cnpj, legal_name, billing_email from clients where agency_id = $1 and archived_at is null`, [agencyId]),
    sql.query<{ client_id: string; amount_cents: number; methods: string[]; next_due: string; active: boolean }>(`select client_id, amount_cents::float8 as amount_cents, methods, next_due::text, active from invoice_recurrences where agency_id = $1`, [agencyId]),
    sql.query<{ id: string; client_id: string; amount_cents: number; due_date: string; payment_url: string | null }>(
      `select id, client_id, amount_cents::float8 as amount_cents, due_date::text, payment_url from invoices where agency_id = $1 and (status = 'vencido' or (status = 'pendente' and due_date < $2::date)) order by due_date`,
      [agencyId, now.toLocaleDateString("en-CA", { timeZone: TZ })]),
    sql.query<{ id: string; label: string; status: string }>(`select id, label, status from integration_connections where agency_id = $1 and provider = 'focusnfe' and status <> 'revoked'`, [agencyId]),
  ]);
  return { config, notes, pending, clients, recurrences, overdue, connections };
}
