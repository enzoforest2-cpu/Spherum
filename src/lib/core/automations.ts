import { z } from "zod";
import { json, num, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { updateDeal } from "./crm";
import type { Mailer } from "./email";
import { addTask, createProject } from "./projects";
import { normPhone } from "./prospect";
import { requestNps } from "./risk";

/**
 * Automações: um gatilho, depois condições, esperas e ações, em ordem. O cron lê os gatilhos nos
 * módulos (o que aconteceu depois de a automação ser ligada), cria uma execução por evento e anda
 * com cada execução até uma espera ou o fim. Condição falsa encerra a execução ("parado").
 */

const TZ = "America/Sao_Paulo";

export const TRIGGERS = {
  formulario: "Formulário enviado",
  reuniao: "Reunião agendada",
  etapa_crm: "Lead mudou de etapa no CRM",
  fatura_vence: "Fatura vence em alguns dias",
  relatorio_publicado: "Relatório publicado",
} as const;
type TriggerType = keyof typeof TRIGGERS;

const trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("formulario"), form_id: z.uuid().nullable().optional() }),
  z.object({ type: z.literal("reuniao"), booking_type_id: z.uuid().nullable().optional() }),
  z.object({ type: z.literal("etapa_crm"), stage: z.enum(["novo", "contato", "diagnostico", "proposta", "negociacao", "ganho", "perdido"]) }),
  z.object({ type: z.literal("fatura_vence"), days: z.number().int().min(0).max(30).default(3) }),
  z.object({ type: z.literal("relatorio_publicado") }),
]);

const step = z.discriminatedUnion("type", [
  // Condições
  z.object({ kind: z.literal("condicao"), type: z.literal("valor_minimo"), value: z.number().min(0) }),
  z.object({ kind: z.literal("condicao"), type: z.literal("tem_telefone") }),
  z.object({ kind: z.literal("condicao"), type: z.literal("fatura_em_aberto") }),
  z.object({ kind: z.literal("condicao"), type: z.literal("reuniao_confirmada") }),
  z.object({ kind: z.literal("condicao"), type: z.literal("etapa_e"), stage: z.string().max(20) }),
  // Esperas
  z.object({ kind: z.literal("espera"), type: z.literal("tempo"), minutes: z.number().int().min(1).max(60 * 24 * 60) }),
  z.object({ kind: z.literal("espera"), type: z.literal("antes_do_evento"), minutes: z.number().int().min(0).max(60 * 24 * 30) }),
  // Ações
  z.object({ kind: z.literal("acao"), type: z.literal("email"), subject: z.string().trim().min(1).max(160), text: z.string().trim().min(1).max(4000), to: z.enum(["lead", "equipe"]).default("lead") }),
  z.object({ kind: z.literal("acao"), type: z.literal("whatsapp"), template: z.string().regex(/^[a-z0-9_]{1,512}$/), text: z.string().trim().max(1024).default(""), lang: z.string().default("pt_BR"), connection_id: z.uuid().nullable().optional() }),
  z.object({ kind: z.literal("acao"), type: z.literal("tarefa"), title: z.string().trim().min(3).max(200), assignee_user: z.uuid().nullable().optional(), due_days: z.number().int().min(0).max(60).default(1) }),
  z.object({ kind: z.literal("acao"), type: z.literal("aviso"), text: z.string().trim().min(3).max(200), user_id: z.uuid().nullable().optional() }),
  z.object({ kind: z.literal("acao"), type: z.literal("nps"), question: z.string().trim().min(10).max(300).default("De 0 a 10, quanto você recomendaria a agência para um amigo?") }),
  z.object({ kind: z.literal("acao"), type: z.literal("xodo"), xodo_id: z.uuid(), text: z.string().trim().min(3).max(2000) }),
  z.object({ kind: z.literal("acao"), type: z.literal("mover_crm"), stage: z.enum(["contato", "diagnostico", "proposta", "negociacao", "perdido"]) }),
]);
export type Step = z.infer<typeof step>;

export const automationInput = z.object({ name: z.string().trim().min(1).max(120), trigger, steps: z.array(step).max(20).default([]) });
export const automationPatch = z.object({ name: z.string().trim().min(1).max(120), trigger, steps: z.array(step).max(20) }).partial();

export type Ctx = {
  kind: TriggerType; name?: string | null; email?: string | null; phone?: string | null; company?: string | null; client_id?: string | null; client_name?: string | null;
  deal_id?: string | null; value_cents?: number | null; booking_id?: string | null; start_at?: string | null; meet?: string | null; type_name?: string | null;
  invoice_id?: string | null; due_date?: string | null; amount_cents?: number | null; payment_url?: string | null; report_id?: string | null; report_title?: string | null; form_name?: string | null;
};

export type AutoDeps = {
  sql: Sql;
  mailer: Mailer;
  whatsapp?: (agencyId: string, connectionId: string, to: string, msg: { kind: "template"; name: string; lang: string; params: string[] }) => Promise<void>;
  askXodo?: (agencyId: string, xodoId: string, text: string) => Promise<string>;
};

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

async function checkRefs(sql: Sql, agencyId: string, t: z.infer<typeof trigger> | undefined, steps: Step[] | undefined) {
  if (t?.type === "formulario" && t.form_id && !(await one(sql, `select 1 from forms where id = $1 and agency_id = $2`, [t.form_id, agencyId]))) throw new XodoError("Formulário não encontrado.", 400);
  if (t?.type === "reuniao" && t.booking_type_id && !(await one(sql, `select 1 from booking_types where id = $1 and agency_id = $2`, [t.booking_type_id, agencyId]))) throw new XodoError("Tipo de reunião não encontrado.", 400);
  for (const s of steps ?? []) {
    const user = "assignee_user" in s ? s.assignee_user : "user_id" in s ? s.user_id : null;
    if (user && !(await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, user]))) throw new XodoError("Um responsável não é da equipe.", 400);
    if (s.type === "xodo" && !(await one(sql, `select 1 from xodos where id = $1 and agency_id = $2`, [s.xodo_id, agencyId]))) throw new XodoError("Xodó não encontrado.", 400);
  }
  if (steps?.some((s) => s.type === "antes_do_evento") && t && !["reuniao", "fatura_vence"].includes(t.type)) throw new XodoError("“Antes do evento” só vale para reunião e fatura.", 400);
}

export async function createAutomation(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const i = automationInput.parse(raw);
  await checkRefs(sql, agencyId, i.trigger, i.steps);
  return (await one<{ id: string }>(sql, `insert into automations (agency_id, name, trigger, steps, created_by) values ($1, $2, $3::jsonb, $4::jsonb, $5) returning id`, [agencyId, i.name, json(i.trigger), json(i.steps), userId]))!;
}

async function autoOf(sql: Sql, agencyId: string, id: string) {
  const a = await one<{ id: string; agency_id: string; name: string; enabled: boolean; trigger: z.infer<typeof trigger>; steps: Step[]; cursor_at: string | null }>(
    sql, `select id, agency_id, name, enabled, trigger, steps, cursor_at::text from automations where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!a) throw new XodoError("Automação não encontrada.", 404);
  return a;
}

export async function updateAutomation(sql: Sql, agencyId: string, id: string, raw: unknown) {
  const i = automationPatch.parse(raw);
  const a = await autoOf(sql, agencyId, id);
  await checkRefs(sql, agencyId, i.trigger ?? a.trigger, i.steps ?? a.steps);
  const sets: string[] = [], vals: unknown[] = [id];
  if (i.name !== undefined) { vals.push(i.name); sets.push(`name = $${vals.length}`); }
  if (i.trigger !== undefined) { vals.push(json(i.trigger)); sets.push(`trigger = $${vals.length}::jsonb`); }
  if (i.steps !== undefined) { vals.push(json(i.steps)); sets.push(`steps = $${vals.length}::jsonb`); }
  if (sets.length) await sql.query(`update automations set ${sets.join(", ")} where id = $1`, vals);
}

/** Liga (a partir de agora: não dispara o que já aconteceu) ou desliga. */
export async function setEnabled(sql: Sql, agencyId: string, id: string, on: boolean, now = new Date()) {
  const a = await autoOf(sql, agencyId, id);
  if (on && !a.steps.some((s) => s.kind === "acao")) throw new XodoError("Adicione pelo menos uma ação antes de ligar.", 400);
  await sql.query(`update automations set enabled = $2, cursor_at = case when $2 then $3::timestamptz else cursor_at end where id = $1`, [id, on, now.toISOString()]);
}

export async function deleteAutomation(sql: Sql, agencyId: string, id: string) {
  await autoOf(sql, agencyId, id);
  await sql.query(`delete from automations where id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Gatilhos
// ---------------------------------------------------------------------------

/** Eventos do gatilho entre `from` e `to` (cada um com uma chave única e o contexto). */
async function events(sql: Sql, agencyId: string, t: z.infer<typeof trigger>, from: string, to: string, now: Date): Promise<{ key: string; ctx: Ctx; at: string | null }[]> {
  if (t.type === "formulario") {
    const rows = await sql.query<{ id: string; deal_id: string | null; form_name: string; company: string | null; name: string | null; email: string | null; phone: string | null; value_cents: number | null; at: string }>(
      `select s.id, s.deal_id, f.name as form_name, d.company, d.contact_name as name, d.email, d.phone, d.value_cents::float8 as value_cents, s.created_at::text as at
         from form_submissions s join forms f on f.id = s.form_id left join deals d on d.id = s.deal_id
        where s.agency_id = $1 and s.created_at > $2 and s.created_at <= $3 and ($4::uuid is null or s.form_id = $4) order by s.created_at`,
      [agencyId, from, to, t.form_id ?? null]);
    return rows.map((r) => ({ key: `form:${r.id}`, at: r.at, ctx: { kind: "formulario", name: r.name, email: r.email, phone: r.phone, company: r.company, deal_id: r.deal_id, value_cents: r.value_cents, form_name: r.form_name } }));
  }
  if (t.type === "reuniao") {
    const rows = await sql.query<{ id: string; name: string; email: string; phone: string | null; start_at: string; meet_link: string | null; type_name: string; deal_id: string | null; client_id: string | null; at: string }>(
      `select b.id, b.name, b.email, b.phone, b.start_at::text, b.meet_link, t.name as type_name, b.deal_id, b.client_id, b.created_at::text as at
         from bookings b join booking_types t on t.id = b.type_id
        where b.agency_id = $1 and b.created_at > $2 and b.created_at <= $3 and b.status = 'confirmada' and ($4::uuid is null or b.type_id = $4) order by b.created_at`,
      [agencyId, from, to, t.booking_type_id ?? null]);
    return rows.map((r) => ({ key: `booking:${r.id}`, at: r.at, ctx: { kind: "reuniao", name: r.name, email: r.email, phone: r.phone, booking_id: r.id, start_at: r.start_at, meet: r.meet_link, type_name: r.type_name, deal_id: r.deal_id, client_id: r.client_id } }));
  }
  if (t.type === "etapa_crm") {
    const rows = await sql.query<{ id: string; company: string; contact_name: string | null; email: string | null; phone: string | null; value_cents: number; stage_changed_at: string }>(
      `select id, company, contact_name, email, phone, value_cents::float8 as value_cents, stage_changed_at::text from deals
        where agency_id = $1 and stage = $4 and stage_changed_at > $2 and stage_changed_at <= $3 order by stage_changed_at`,
      [agencyId, from, to, t.stage]);
    return rows.map((r) => ({ key: `deal:${r.id}:${t.stage}:${r.stage_changed_at}`, at: r.stage_changed_at, ctx: { kind: "etapa_crm", name: r.contact_name, email: r.email, phone: r.phone, company: r.company, deal_id: r.id, value_cents: r.value_cents } }));
  }
  if (t.type === "fatura_vence") {
    // A fatura "entra" no gatilho quando faltam N dias para vencer.
    const target = new Date(now.getTime() + t.days * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
    const rows = await sql.query<{ id: string; client_id: string; client_name: string; due_date: string; amount_cents: number; payment_url: string | null; email: string | null; phone: string | null; contact: string | null }>(
      `select i.id, i.client_id, c.name as client_name, i.due_date::text, i.amount_cents::float8 as amount_cents, i.payment_url,
              cc.email, cc.phone, cc.name as contact
         from invoices i join clients c on c.id = i.client_id
         left join lateral (select email, phone, name from client_contacts where client_id = i.client_id order by is_primary desc, created_at limit 1) cc on true
        where i.agency_id = $1 and i.status = 'pendente' and i.due_date <= $2::date and i.due_date >= ($3::timestamptz at time zone 'America/Sao_Paulo')::date`,
      [agencyId, target, from]);
    return rows.map((r) => ({ key: `invoice:${r.id}:${t.days}`, at: null, ctx: { kind: "fatura_vence", name: r.contact, email: r.email, phone: r.phone, company: r.client_name, client_id: r.client_id, client_name: r.client_name, invoice_id: r.id, due_date: r.due_date, amount_cents: r.amount_cents, payment_url: r.payment_url } }));
  }
  const rows = await sql.query<{ id: string; title: string; client_id: string; client_name: string; email: string | null; phone: string | null; contact: string | null; at: string }>(
    `select r.id, r.title, r.client_id, c.name as client_name, cc.email, cc.phone, cc.name as contact, r.published_at::text as at
       from reports r join clients c on c.id = r.client_id
       left join lateral (select email, phone, name from client_contacts where client_id = r.client_id order by is_primary desc, created_at limit 1) cc on true
      where r.agency_id = $1 and r.status = 'published' and r.published_at > $2 and r.published_at <= $3`,
    [agencyId, from, to]);
  return rows.map((r) => ({ key: `report:${r.id}`, at: r.at, ctx: { kind: "relatorio_publicado", name: r.contact, email: r.email, phone: r.phone, company: r.client_name, client_id: r.client_id, client_name: r.client_name, report_id: r.id, report_title: r.title } }));
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const fmtDay = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const fmtHour = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

/** Troca {nome}, {empresa}, {email}, {telefone}, {data}, {hora}, {link}, {valor}, {cliente} pelo contexto. */
export function fill(text: string, c: Ctx) {
  const when = c.start_at ?? c.due_date ?? null;
  const map: Record<string, string> = {
    nome: (c.name ?? "").split(" ")[0] || c.company || "", empresa: c.company ?? c.client_name ?? "", cliente: c.client_name ?? c.company ?? "", email: c.email ?? "", telefone: c.phone ?? "",
    data: when ? fmtDay(when) : "", hora: c.start_at ? fmtHour(c.start_at) : "", link: c.meet ?? c.payment_url ?? "",
    valor: c.amount_cents ?? c.value_cents ? `R$ ${Math.round(num(c.amount_cents ?? c.value_cents) / 100).toLocaleString("pt-BR")}` : "",
    reuniao: c.type_name ?? "", relatorio: c.report_title ?? "", formulario: c.form_name ?? "",
  };
  return text.replace(/\{([a-z]+)\}/g, (all, k: string) => (k in map ? map[k] : all)).replace(/\s{2,}/g, " ").trim();
}

type LogLine = { at: string; step: number; text: string; ok: boolean };

async function condition(sql: Sql, s: Step, c: Ctx): Promise<[boolean, string]> {
  if (s.type === "valor_minimo") { const v = num(c.value_cents ?? c.amount_cents ?? 0) / 100; return [v >= s.value, `Valor R$ ${Math.round(v).toLocaleString("pt-BR")} ${v >= s.value ? "≥" : "<"} R$ ${s.value.toLocaleString("pt-BR")}`]; }
  if (s.type === "tem_telefone") return [!!c.phone && !!normPhone(c.phone), c.phone ? "Tem WhatsApp" : "Sem WhatsApp"];
  if (s.type === "fatura_em_aberto") { const r = c.invoice_id ? await one<{ status: string }>(sql, `select status from invoices where id = $1`, [c.invoice_id]) : null; return [r?.status === "pendente" || r?.status === "vencido", `Fatura ${r?.status ?? "não encontrada"}`]; }
  if (s.type === "reuniao_confirmada") { const r = c.booking_id ? await one<{ status: string }>(sql, `select status from bookings where id = $1`, [c.booking_id]) : null; return [r?.status === "confirmada", `Reunião ${r?.status ?? "não encontrada"}`]; }
  if (s.type === "etapa_e") { const r = c.deal_id ? await one<{ stage: string }>(sql, `select stage from deals where id = $1`, [c.deal_id]) : null; return [r?.stage === s.stage, `Etapa ${r?.stage ?? "?"}`]; }
  return [true, ""];
}

/** Quando a espera termina (null: já passou). */
function waitUntil(s: Step, c: Ctx, now: Date): Date | null {
  if (s.type === "tempo") return new Date(now.getTime() + s.minutes * 60_000);
  if (s.type === "antes_do_evento") {
    const ev = c.start_at ? new Date(c.start_at) : c.due_date ? new Date(`${c.due_date}T09:00:00-03:00`) : null;
    if (!ev) return null;
    const at = new Date(ev.getTime() - s.minutes * 60_000);
    return at > now ? at : null;
  }
  return null;
}

async function automationProject(sql: Sql, agencyId: string, userId: string, now: Date) {
  const name = "Tarefas das automações";
  const p = await one<{ id: string }>(sql, `select id from projects where agency_id = $1 and client_id is null and name = $2 and status <> 'done'`, [agencyId, name]);
  if (p) return p.id;
  return (await createProject(sql, agencyId, userId, { name, owner_user: userId, tags: ["Automação"], due_date: new Date(now.getTime() + 90 * 864e5).toISOString().slice(0, 10) }, now)).id;
}

async function action(deps: AutoDeps, agencyId: string, actor: string, s: Step, c: Ctx, now: Date, dry: boolean): Promise<string> {
  const { sql } = deps;
  if (s.type === "email") {
    const to = s.to === "equipe" ? (await sql.query<{ email: string }>(`select u.email from agency_members m join auth.users u on u.id = m.user_id where m.agency_id = $1 and m.role in ('owner', 'admin')`, [agencyId])).map((r) => r.email) : c.email ? [c.email] : [];
    if (!to.length) throw new XodoError("Sem e-mail para enviar.", 400);
    if (!dry) await deps.mailer({ to, subject: fill(s.subject, c), text: fill(s.text, c) });
    return `E-mail para ${to.join(", ")}: ${fill(s.subject, c)}`;
  }
  if (s.type === "whatsapp") {
    const to = c.phone ? normPhone(c.phone) : null;
    if (!to) throw new XodoError("Sem WhatsApp válido.", 400);
    const conn = s.connection_id ?? (await one<{ id: string }>(sql, `select id from integration_connections where agency_id = $1 and provider = 'whatsapp_cloud' and status = 'active' order by created_at limit 1`, [agencyId]))?.id;
    if (!conn) throw new XodoError("Conecte o WhatsApp oficial (API da Meta) em Integrações.", 400);
    const optout = await one(sql, `select 1 from prospect_optouts where agency_id = $1 and phone = $2`, [agencyId, to]);
    if (optout) throw new XodoError("Esse número pediu para não receber mensagens.", 409);
    if (!dry) {
      if (!deps.whatsapp) throw new XodoError("WhatsApp indisponível agora.", 503);
      // Variáveis do modelo ({{1}}, {{2}}…) na ordem em que aparecem no texto.
      await deps.whatsapp(agencyId, conn, to, { kind: "template", name: s.template, lang: s.lang, params: [...s.text.matchAll(/\{([a-z]+)\}/g)].map((m) => fill(`{${m[1]}}`, c) || "-") });
    }
    return `WhatsApp (modelo ${s.template}) para ${c.name || to}`;
  }
  if (s.type === "tarefa") {
    const title = fill(s.title, c).slice(0, 200);
    if (!dry) {
      const pid = await automationProject(sql, agencyId, actor, now);
      await addTask(sql, agencyId, pid, { title, assignee_user: s.assignee_user ?? null, due_date: new Date(now.getTime() + s.due_days * 864e5).toLocaleDateString("en-CA", { timeZone: TZ }) });
    }
    return `Tarefa: ${title}`;
  }
  if (s.type === "aviso") {
    const text = fill(s.text, c).slice(0, 200);
    if (!dry) await sql.query(`insert into notifications (agency_id, user_id, kind, title, data) values ($1, $2, 'automacao', $3, $4::jsonb)`, [agencyId, s.user_id ?? null, text, json({ deal_id: c.deal_id ?? null, client_id: c.client_id ?? null })]);
    return `Aviso: ${text}`;
  }
  if (s.type === "nps") {
    if (!c.client_id) throw new XodoError("NPS só para clientes (este evento não tem cliente).", 400);
    if (!dry) await requestNps(sql, agencyId, actor, { client_ids: [c.client_id], question: s.question });
    return `NPS pedido no portal de ${c.client_name ?? "cliente"}`;
  }
  if (s.type === "xodo") {
    const text = fill(s.text, c);
    if (!dry) { if (!deps.askXodo) throw new XodoError("Xodós indisponíveis agora.", 503); await deps.askXodo(agencyId, s.xodo_id, text); }
    return `Pedido ao xodó: ${text.slice(0, 120)}`;
  }
  if (s.type === "mover_crm") {
    if (!c.deal_id) throw new XodoError("Este evento não tem negócio no CRM.", 400);
    if (!dry) await updateDeal(sql, agencyId, actor, c.deal_id, { stage: s.stage });
    return `Negócio movido para ${s.stage}`;
  }
  return "";
}

/** Anda com uma execução até uma espera, uma condição falsa, um erro ou o fim. */
async function advance(deps: AutoDeps, runId: string, now: Date) {
  const { sql } = deps;
  const r = await one<{ id: string; automation_id: string; agency_id: string; step: number; context: Ctx; log: LogLine[]; steps: Step[]; actor: string; status: string; resume_at: string | null }>(
    sql,
    `update automation_runs r set status = 'rodando' from automations a
      where r.id = $1 and a.id = r.automation_id and r.status in ('pendente', 'esperando')
      returning r.id, r.automation_id, r.agency_id, r.step, r.context, r.log, a.steps,
        coalesce(a.created_by, (select user_id from agency_members m where m.agency_id = a.agency_id and m.role = 'owner' limit 1)) as actor, r.status, r.resume_at::text`,
    [runId],
  );
  if (!r) return;
  const log = [...(r.log ?? [])];
  const push = (stepNo: number, text: string, ok = true) => log.push({ at: now.toISOString(), step: stepNo, text, ok });
  let i = r.step;
  // Voltando de uma espera: o passo de espera terminou.
  if (r.status === "esperando" && r.steps[i]?.kind === "espera") i++;
  const save = (status: string, extra: { resume_at?: string | null; error?: string | null } = {}) =>
    sql.query(`update automation_runs set status = $2, step = $3, log = $4::jsonb, resume_at = $5, error = $6 where id = $1`, [runId, status, i, json(log.slice(-60)), extra.resume_at ?? null, extra.error ?? null]);
  try {
    for (; i < r.steps.length; i++) {
      const s = r.steps[i];
      if (s.kind === "condicao") {
        const [ok, why] = await condition(sql, s, r.context);
        push(i, `Condição: ${why}`, ok);
        if (!ok) { await save("parado"); return; }
      } else if (s.kind === "espera") {
        const until = waitUntil(s, r.context, now);
        if (until) { push(i, `Esperando até ${until.toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`); await save("esperando", { resume_at: until.toISOString() }); return; }
        push(i, "Espera já passou");
      } else {
        push(i, await action(deps, r.agency_id, r.actor, s, r.context, now, false));
      }
    }
    await save("feito");
  } catch (error) {
    const msg = (error instanceof Error ? error.message : String(error)).slice(0, 600);
    push(i, msg, false);
    await save("falhou", { error: msg });
  }
}

/** Cron: dispara os eventos novos de cada automação ligada e anda com as execuções vencidas. */
export async function automationSweep(deps: AutoDeps, now = new Date(), opts: { deadline?: number } = {}) {
  const { sql } = deps;
  const out = { started: 0, advanced: 0, stuck: 0, errors: 0 };
  // Execução que ficou "rodando" por mais de 30 minutos: o processo caiu no meio de uma ação. Vira falha, com registro.
  out.stuck = (await sql.query(`update automation_runs set status = 'falhou', error = 'A execução parou no meio (o processo caiu). Confira o que já saiu antes de rodar de novo.' where status = 'rodando' and updated_at < $1::timestamptz - interval '30 minutes' returning id`, [now.toISOString()])).length;
  const autos = await sql.query<{ id: string; agency_id: string; trigger: z.infer<typeof trigger>; cursor_at: string }>(
    `select au.id, au.agency_id, au.trigger, coalesce(au.cursor_at, now())::text as cursor_at from automations au join agencies ag on ag.id = au.agency_id
      where au.enabled and ag.suspended_at is null`);
  // Agência suspensa: os eventos do período não disparam depois, quando ela for reativada.
  await sql.query(`update automations set cursor_at = $1 where enabled and agency_id in (select id from agencies where suspended_at is not null)`, [now.toISOString()]);
  for (const a of autos) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    // Uma automação com gatilho quebrado não para as outras agências.
    try {
      const evs = await events(sql, a.agency_id, a.trigger, a.cursor_at, now.toISOString(), now);
      const batch = evs.slice(0, 200);
      for (const e of batch) {
        const ins = await one<{ id: string }>(sql, `insert into automation_runs (automation_id, agency_id, event_key, context, resume_at) values ($1, $2, $3, $4::jsonb, $5) on conflict do nothing returning id`,
          [a.id, a.agency_id, e.key, json(e.ctx), now.toISOString()]);
        if (ins) { out.started++; await sql.query(`update automations set runs = runs + 1, last_run_at = $2 where id = $1`, [a.id, now.toISOString()]); }
      }
      // Fatura: o gatilho olha a data de vencimento, não um instante; o cursor só avança nos outros. Num pico com mais de
      // 200 eventos, o cursor para no último lido, e o resto entra no próximo ciclo.
      if (a.trigger.type !== "fatura_vence") {
        const cursor = evs.length > batch.length && batch[batch.length - 1].at ? batch[batch.length - 1].at! : now.toISOString();
        await sql.query(`update automations set cursor_at = $2 where id = $1`, [a.id, cursor]);
      }
    } catch (error) {
      out.errors++;
      console.error("[automacoes] gatilho falhou", a.id, error);
    }
  }
  const due = await sql.query<{ id: string }>(`select r.id from automation_runs r join automations a on a.id = r.automation_id join agencies ag on ag.id = r.agency_id
      where a.enabled and ag.suspended_at is null and r.status in ('pendente', 'esperando') and r.resume_at <= $1 order by r.resume_at limit 200`, [now.toISOString()]);
  for (const d of due) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    await advance(deps, d.id, now);
    out.advanced++;
  }
  return out;
}

/** "Testar agora": roda com um exemplo (o último evento do gatilho, se houver), sem enviar nada. */
export async function testAutomation(deps: AutoDeps, agencyId: string, id: string, now = new Date()) {
  const a = await autoOf(deps.sql, agencyId, id);
  const recent = await events(deps.sql, agencyId, a.trigger, new Date(now.getTime() - 90 * 864e5).toISOString(), now.toISOString(), now);
  const ctx: Ctx = recent.at(-1)?.ctx ?? { kind: a.trigger.type, name: "Ana Exemplo", email: "ana@exemplo.com", phone: "(41) 99999-0000", company: "Empresa Exemplo", value_cents: 800000, start_at: new Date(now.getTime() + 2 * 864e5).toISOString(), due_date: new Date(now.getTime() + 3 * 864e5).toISOString().slice(0, 10), amount_cents: 250000 };
  const lines: { step: number; text: string; ok: boolean }[] = [];
  for (const [i, s] of a.steps.entries()) {
    try {
      if (s.kind === "condicao") { const [ok, why] = await condition(deps.sql, s, ctx); lines.push({ step: i, text: `Condição: ${why}`, ok }); if (!ok) break; }
      else if (s.kind === "espera") lines.push({ step: i, text: s.type === "tempo" ? `Espera ${s.minutes} min` : `Espera até ${s.minutes} min antes do evento`, ok: true });
      else lines.push({ step: i, text: await action(deps, agencyId, "", s, ctx, now, true), ok: true });
    } catch (error) {
      lines.push({ step: i, text: error instanceof Error ? error.message : String(error), ok: false });
      break;
    }
  }
  return { example: recent.length ? "último evento real" : "exemplo", lines };
}

export async function automationBoard(sql: Sql, agencyId: string) {
  const [autos, runs] = await Promise.all([
    sql.query<{ id: string; name: string; enabled: boolean; trigger: unknown; steps: Step[]; runs: number; last_run_at: string | null; created_at: string }>(
      `select id, name, enabled, trigger, steps, runs, last_run_at::text, created_at::text from automations where agency_id = $1 order by created_at`, [agencyId]),
    sql.query<{ id: string; automation_id: string; status: string; context: Ctx; log: LogLine[]; error: string | null; resume_at: string | null; updated_at: string }>(
      `select id, automation_id, status, context, log, error, resume_at::text, updated_at::text from automation_runs where agency_id = $1 order by updated_at desc limit 30`, [agencyId]),
  ]);
  return { automations: autos, runs, triggers: TRIGGERS };
}
