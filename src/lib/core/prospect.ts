import { createHash } from "node:crypto";
import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { createDeal } from "./crm";
import { platformFlags, requireFeature } from "./platform";

/**
 * Prospecção: listas próprias da agência (planilha ou números colados) e uma cadência pelo
 * WhatsApp oficial. A Meta só aceita começar conversa com modelo aprovado, então cada passo (e
 * cada variação do primeiro) aponta para um modelo; o texto do passo é o corpo do modelo, com
 * {nome}, {empresa}, {segmento} e {cidade} no lugar das variáveis {{1}}, {{2}}… na ordem em que
 * aparecem. Quem responde sai da cadência e vai para Conversas; quem pede para sair é bloqueado
 * para sempre. Envios só de segunda a sexta, das 9h às 18h (Brasília), até o limite do dia.
 */

export const PLACEHOLDERS = ["nome", "empresa", "segmento", "cidade"] as const;
export const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|remover)[\s.!]*$/i;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TZ = "America/Sao_Paulo";

const body = z
  .string()
  .trim()
  .min(5)
  .max(1024)
  .refine((t) => !/\{[^{}]*\|[^{}]*\}/.test(t), "Modelos da Meta têm texto fixo: em vez de {a|b}, crie variações com outros modelos.")
  .refine((t) => [...t.matchAll(/\{([^{}]+)\}/g)].every((m) => (PLACEHOLDERS as readonly string[]).includes(m[1])), "Use só {nome}, {empresa}, {segmento} e {cidade}.");
const template = z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Nome do modelo: letras minúsculas, números e _ (como na Meta).").nullable();

export const configInput = z.object({
  connection_id: z.uuid().nullable().optional(),
  daily_limit: z.number().int().min(10).max(250).optional(),
  running: z.boolean().optional(),
  lang: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/).optional(),
  steps: z.array(z.object({ t: z.string().trim().min(1).max(60), day: z.number().int().min(0).max(30), text: body, template })).min(1).max(5).optional(),
  // Variações do primeiro passo: cada lead recebe uma das ativas (teste A/B entre modelos).
  variations: z.array(z.object({ style: z.string().trim().min(1).max(40), text: body, template, on: z.boolean().default(true) })).max(8).optional(),
});
export type ProspectConfig = {
  connection_id: string | null; daily_limit: number; running: boolean; lang: string;
  steps: { t: string; day: number; text: string; template: string | null }[];
  variations: { style: string; text: string; template: string | null; on: boolean }[];
};

export const DEFAULT_CONFIG: ProspectConfig = {
  connection_id: null, daily_limit: 50, running: false, lang: "pt_BR",
  steps: [
    { t: "Primeira mensagem", day: 0, text: "Olá, {nome}! Aqui é da agência. A gente ajuda {segmento} a atrair clientes com anúncios. Posso te mandar 2 ideias para a {empresa}?", template: null },
    { t: "Follow-up", day: 2, text: "{nome}, passando de novo. Separei um exemplo de campanha para um negócio parecido com a {empresa}. Quer ver?", template: null },
    { t: "Última tentativa", day: 5, text: "Última mensagem! Se não for o momento, sem problema. Se preferir não receber mais, responda SAIR.", template: null },
  ],
  variations: [],
};

export async function getConfig(sql: Sql, agencyId: string): Promise<ProspectConfig> {
  const row = await one<{ c: Partial<ProspectConfig> }>(sql, `select prospect_config as c from agencies where id = $1`, [agencyId]);
  return { ...DEFAULT_CONFIG, ...(row?.c ?? {}) };
}

export async function setConfig(sql: Sql, agencyId: string, raw: unknown) {
  const input = configInput.parse(raw);
  const next = { ...(await getConfig(sql, agencyId)), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ProspectConfig;
  if (next.connection_id) {
    const c = await one<{ provider: string; status: string }>(sql, `select provider, status from integration_connections where id = $1 and agency_id = $2`, [next.connection_id, agencyId]);
    if (!c || c.provider !== "whatsapp_cloud") throw new XodoError("Escolha uma conexão do WhatsApp oficial (API da Meta).", 400);
  }
  if (next.running) {
    if (!next.connection_id) throw new XodoError("Conecte o WhatsApp oficial antes de disparar.", 400);
    const missing = next.steps.findIndex((s) => !s.template);
    if (missing >= 0) throw new XodoError(`Falta o modelo aprovado da Meta no passo ${missing + 1}.`, 400);
    if (next.variations.some((v) => v.on && !v.template)) throw new XodoError("Toda variação ativa precisa de um modelo aprovado.", 400);
    if (!/sair|parar/i.test(next.steps[next.steps.length - 1].text)) throw new XodoError("A última mensagem precisa oferecer a saída (ex.: “responda SAIR”).", 400);
  }
  await sql.query(`update agencies set prospect_config = $2::jsonb where id = $1`, [agencyId, json(next)]);
  return next;
}

// ---------------------------------------------------------------------------
// Números e textos
// ---------------------------------------------------------------------------

/** Telefone brasileiro em dígitos com o 55, ou null. */
export function normPhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length !== 10 && d.length !== 11) return null;
  if (!/^[1-9][1-9]/.test(d) || (d.length === 11 && d[2] !== "9")) return null;
  return "55" + d;
}

/** O WhatsApp às vezes manda o celular sem o 9 da frente: os dois jeitos valem. */
export function phoneKeys(waId: string): string[] {
  const d = waId.replace(/\D/g, "");
  if (/^55\d{2}9\d{8}$/.test(d)) return [d, d.slice(0, 4) + d.slice(5)];
  if (/^55\d{2}[6-9]\d{7}$/.test(d)) return [d, d.slice(0, 4) + "9" + d.slice(4)];
  return [d];
}

export const fmtPhone = (p: string) => { const d = p.slice(2); return `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}`; };

type LeadData = { name: string | null; company: string | null; segment: string | null; city: string | null };
const valueOf = (lead: LeadData, k: string) =>
  (k === "nome" ? (lead.name ?? "").split(" ")[0] || lead.company : k === "empresa" ? lead.company || lead.name : k === "segmento" ? lead.segment : lead.city) || "";

export function fillText(text: string, lead: LeadData) {
  return text.replace(/\{(nome|empresa|segmento|cidade)\}/g, (_, k) => valueOf(lead, k) || "você").replace(/\s{2,}/g, " ");
}

/** Parâmetros do modelo ({{1}}, {{2}}…) na ordem em que as variáveis aparecem no texto. */
export function templateParams(text: string, lead: LeadData) {
  return [...text.matchAll(/\{(nome|empresa|segmento|cidade)\}/g)].map((m) => valueOf(lead, m[1]) || "-");
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

const row = z.object({
  phone: z.string().max(40),
  name: z.string().trim().max(120).optional(),
  company: z.string().trim().max(160).optional(),
  email: z.string().trim().max(254).optional(),
  segment: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  website: z.string().trim().max(300).optional(),
  // De onde veio o contato (LGPD): "Google Maps: ...", "Receita Federal (CNPJ ...)", "Instagram @...".
  origin: z.string().trim().max(200).optional(),
});
export const importInput = z.object({
  list: z.string().trim().min(1).max(80),
  source: z.enum(["planilha", "colado", "manual", "google_maps", "cnpj", "instagram", "grupo_whatsapp"]).default("planilha"),
  rows: z.array(row).max(10_000).optional(),
  // Uma linha por contato: "telefone, nome, empresa".
  text: z.string().max(400_000).optional(),
  // Quem importa confirma que os contatos são da agência (clientes, eventos, indicações) e podem receber mensagem.
  consent: z.literal(true, { error: "Confirme que a lista é da agência e que esses contatos podem receber mensagem." }),
});

export async function importLeads(sql: Sql, agencyId: string, userId: string, raw: unknown, dryRun = false) {
  await requireFeature(sql, "prospect");
  const input = importInput.parse(raw);
  const rows = input.rows ?? (input.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [phone, name, company] = l.split(/[,;\t]/).map((x) => x.trim());
    return { phone: phone ?? "", name, company };
  });
  if (!rows.length) throw new XodoError("A lista está vazia.", 400);
  const seen = new Set<string>();
  const good: (z.infer<typeof row> & { phone: string })[] = [];
  let bad = 0, dup = 0;
  for (const r of rows) {
    const p = normPhone(r.phone);
    if (!p) { bad++; continue; }
    if (seen.has(p)) { dup++; continue; }
    seen.add(p);
    good.push({ ...r, phone: p });
  }
  const phones = good.map((g) => g.phone);
  const [existing, blocked] = await Promise.all([
    sql.query<{ phone: string }>(`select phone from prospect_leads where agency_id = $1 and phone = any($2::text[])`, [agencyId, phones]),
    sql.query<{ phone: string }>(`select phone from prospect_optouts where agency_id = $1 and phone = any($2::text[])`, [agencyId, phones]),
  ]);
  const ex = new Set(existing.map((e) => e.phone)), bl = new Set(blocked.map((e) => e.phone));
  const fresh = good.filter((g) => !ex.has(g.phone) && !bl.has(g.phone));
  if (!dryRun) {
    for (const g of fresh) {
      await sql.query(
        `insert into prospect_leads (agency_id, list_name, name, company, phone, email, segment, city, source, created_by, website, origin)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing`,
        [agencyId, input.list, g.name || null, g.company || null, g.phone, g.email || null, g.segment || null, g.city || null, input.source, userId, g.website || null, g.origin || null],
      );
    }
  }
  return { added: fresh.length, bad, dup: dup + ex.size, blocked: bl.size };
}

async function leadOf(sql: Sql, agencyId: string, id: string) {
  const l = await one<{ id: string; stage: string; phone: string; name: string | null; company: string | null; segment: string | null; city: string | null; email: string | null; list_name: string; last_in_at: string | null; deal_id: string | null; owner_user: string | null }>(
    sql, `select id, stage, phone, name, company, segment, city, email, list_name, last_in_at::text, deal_id, owner_user from prospect_leads where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!l) throw new XodoError("Lead não encontrado.", 404);
  return l;
}

/** Coloca leads novos (ou que falharam) na fila da cadência, a partir do primeiro passo. */
export async function queueLeads(sql: Sql, agencyId: string, ids: string[], now = new Date()) {
  const r = await sql.query<{ id: string }>(
    `update prospect_leads set stage = 'fila', step = 0, next_at = $3, error = null
      where agency_id = $1 and id = any($2::uuid[]) and stage in ('novo', 'erro')
        and phone not in (select phone from prospect_optouts where agency_id = $1) returning id`,
    [agencyId, ids, now.toISOString()],
  );
  return { queued: r.length };
}

export async function deleteLeads(sql: Sql, agencyId: string, ids: string[]) {
  const r = await sql.query(`delete from prospect_leads where agency_id = $1 and id = any($2::uuid[]) returning id`, [agencyId, ids]);
  return { deleted: r.length };
}

export const leadPatch = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("etapa"), stage: z.enum(["novo", "respondeu", "qualificado", "reuniao"]) }),
  z.object({ acao: z.literal("dono"), owner_user: z.uuid().nullable() }),
  z.object({ acao: z.literal("nota"), text: z.string().trim().min(1).max(2000) }),
  z.object({ acao: z.literal("parar") }),
]);

export async function updateLead(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown) {
  const p = leadPatch.parse(raw);
  const l = await leadOf(sql, agencyId, id);
  if (p.acao === "etapa") {
    if (l.stage === "saiu" || l.stage === "crm") throw new XodoError(l.stage === "saiu" ? "Esse contato pediu para sair." : "Esse lead já está no CRM.", 409);
    await sql.query(`update prospect_leads set stage = $3, next_at = null where id = $1 and agency_id = $2`, [id, agencyId, p.stage]);
  } else if (p.acao === "dono") {
    if (p.owner_user && !(await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, p.owner_user]))) throw new XodoError("Essa pessoa não é da equipe.", 400);
    await sql.query(`update prospect_leads set owner_user = $3 where id = $1 and agency_id = $2`, [id, agencyId, p.owner_user]);
  } else if (p.acao === "nota") {
    await sql.query(`insert into prospect_messages (lead_id, agency_id, dir, text, author_user) values ($1, $2, 'note', $3, $4)`, [id, agencyId, p.text, userId]);
  } else {
    // Bloqueio pedido pela equipe (ex.: a pessoa pediu por outro canal).
    await optOut(sql, agencyId, l.id, l.phone, "Bloqueado pela equipe · não recebe mais mensagens");
  }
}

async function optOut(sql: Sql, agencyId: string, leadId: string, phone: string, note: string) {
  await sql.query(`insert into prospect_optouts (agency_id, phone) values ($1, $2) on conflict do nothing`, [agencyId, phone]);
  await sql.query(`update prospect_leads set stage = 'saiu', next_at = null where id = $1`, [leadId]);
  await sql.query(`insert into prospect_messages (lead_id, agency_id, dir, text) values ($1, $2, 'sys', $3)`, [leadId, agencyId, note]);
}

/** Lead que respondeu vira negócio no CRM (etapa "Contato realizado"), com a conversa nas observações. */
export async function leadToCrm(sql: Sql, agencyId: string, userId: string, id: string) {
  const l = await leadOf(sql, agencyId, id);
  if (l.deal_id) throw new XodoError("Esse lead já está no CRM.", 409);
  if (l.stage === "saiu") throw new XodoError("Esse contato pediu para sair.", 409);
  const msgs = await sql.query<{ dir: string; text: string }>(`select dir, text from prospect_messages where lead_id = $1 and dir in ('in', 'out') order by id desc limit 6`, [id]);
  const notes = [`Prospecção · lista "${l.list_name}"`, ...msgs.reverse().map((m) => `${m.dir === "in" ? "Lead" : "Agência"}: ${m.text}`)].join("\n").slice(0, 4000);
  const deal = await createDeal(sql, agencyId, userId, {
    company: (l.company || l.name || fmtPhone(l.phone)).slice(0, 160), contact_name: l.name, phone: fmtPhone(l.phone), email: l.email && /^\S+@\S+\.\S+$/.test(l.email) ? l.email : null,
    segment: l.segment, source: "Prospecção", stage: "contato", owner_user: l.owner_user ?? userId, notes,
  });
  await sql.query(`update prospect_leads set stage = 'crm', deal_id = $3, next_at = null where id = $1 and agency_id = $2`, [id, agencyId, deal.id]);
  await sql.query(`insert into prospect_messages (lead_id, agency_id, dir, text) values ($1, $2, 'sys', 'Movido para o CRM como oportunidade')`, [id, agencyId]);
  return deal;
}

export type ProspectSender = (to: string, message: { kind: "template"; name: string; lang: string; params: string[] } | { kind: "text"; text: string }) => Promise<void>;
export type SenderFor = (agencyId: string, connectionId: string) => ProspectSender;

/** Resposta manual em Conversas: texto livre só até 24 horas depois da última mensagem do lead. */
export async function replyLead(sql: Sql, senderFor: SenderFor, agencyId: string, userId: string, id: string, text: string, now = new Date()) {
  const t = z.string().trim().min(1).max(4096).parse(text);
  const l = await leadOf(sql, agencyId, id);
  if (l.stage === "saiu") throw new XodoError("Esse contato pediu para sair.", 409);
  if (!l.last_in_at || now.getTime() - Date.parse(l.last_in_at) > WINDOW_MS) throw new XodoError("Passou a janela de 24 horas do WhatsApp: só dá para responder até 24 horas depois da última mensagem do lead.", 409);
  const cfg = await getConfig(sql, agencyId);
  if (!cfg.connection_id) throw new XodoError("Conecte o WhatsApp oficial em Prospecção.", 400);
  await senderFor(agencyId, cfg.connection_id)(l.phone, { kind: "text", text: t });
  await sql.query(`insert into prospect_messages (lead_id, agency_id, dir, text, author_user) values ($1, $2, 'out', $3, $4)`, [id, agencyId, t, userId]);
  await sql.query(`update prospect_leads set last_out_at = $2 where id = $1`, [id, now.toISOString()]);
}

/**
 * Mensagem recebida no WhatsApp oficial de um número que a agência abordou: fica na conversa do
 * lead, tira da cadência e, se for SAIR/PARAR, bloqueia. Devolve null quando não é de prospecção.
 */
export async function prospectInbound(sql: Sql, agencyId: string, waId: string, text: string, eventId: string, at: Date) {
  const lead = await one<{ id: string; phone: string; stage: string }>(
    // Só leads ainda na prospecção: quem virou cliente ou foi para o CRM conversa com a agência pelo canal normal.
    sql, `select id, phone, stage from prospect_leads where agency_id = $1 and phone = any($2::text[]) and last_out_at is not null and stage in ('fila', 'abordado', 'respondeu', 'erro') order by last_out_at desc limit 1`,
    [agencyId, phoneKeys(waId)]);
  if (!lead) return null;
  const ins = await one<{ id: number }>(
    sql, `insert into prospect_messages (lead_id, agency_id, dir, text, wa_event_id, created_at) values ($1, $2, 'in', $3, $4, $5) on conflict (wa_event_id) do nothing returning id`,
    [lead.id, agencyId, text.slice(0, 4096) || "(mensagem sem texto)", eventId, at.toISOString()]);
  if (!ins) return { status: "duplicate" as const };
  if (OPT_OUT.test(text)) {
    await optOut(sql, agencyId, lead.id, lead.phone, "Pediu para sair · bloqueado automaticamente");
    return { status: "optout" as const, leadId: lead.id };
  }
  await sql.query(
    `update prospect_leads set last_in_at = greatest(coalesce(last_in_at, $2), $2), next_at = null,
            stage = case when stage in ('fila', 'abordado', 'erro') then 'respondeu' else stage end where id = $1`,
    [lead.id, at.toISOString()],
  );
  return { status: "reply" as const, leadId: lead.id };
}

// ---------------------------------------------------------------------------
// Cadência
// ---------------------------------------------------------------------------

/** Segunda a sexta, das 9h às 18h no horário de Brasília. */
export function inWindow(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now).map((p) => [p.type, p.value]));
  const h = Number(parts.hour) % 24;
  return !["Sat", "Sun"].includes(parts.weekday) && h >= 9 && h < 18;
}

const dayStart = (now: Date) => {
  const d = now.toLocaleDateString("en-CA", { timeZone: TZ });
  return new Date(`${d}T03:00:00Z`); // meia-noite em Brasília (UTC−3)
};

async function sentToday(sql: Sql, agencyId: string, now: Date) {
  return (await one<{ n: number }>(sql, `select count(*)::int as n from prospect_messages where agency_id = $1 and dir = 'out' and step is not null and created_at >= $2`, [agencyId, dayStart(now).toISOString()]))!.n;
}

const pick = (id: string, n: number) => parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % n;

/** Envia os passos vencidos das agências com a cadência ligada, dentro da janela e do limite do dia. */
export async function prospectSweep(sql: Sql, senderFor: SenderFor, now = new Date(), opts: { deadline?: number } = {}) {
  const out = { sent: 0, failed: 0, agencies: 0 };
  if (!inWindow(now)) return out;
  // Desligada pela equipe do Spherum: nenhuma cadência anda. Agência suspensa também não envia.
  if (!(await platformFlags(sql)).prospect) return out;
  const agencies = await sql.query<{ id: string }>(`select id from agencies where prospect_config->>'running' = 'true' and suspended_at is null and locked_at is null`);
  for (const a of agencies) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const cfg = await getConfig(sql, a.id);
    if (!cfg.connection_id) continue;
    const budget = cfg.daily_limit - (await sentToday(sql, a.id, now));
    if (budget <= 0) continue;
    out.agencies++;
    const due = await sql.query<{ id: string; phone: string; step: number; name: string | null; company: string | null; segment: string | null; city: string | null }>(
      `select id, phone, step, name, company, segment, city from prospect_leads
        where agency_id = $1 and stage in ('fila', 'abordado') and next_at <= $2
          and phone not in (select phone from prospect_optouts where agency_id = $1)
        order by next_at limit $3`,
      [a.id, now.toISOString(), Math.min(budget, 50)],
    );
    const send = senderFor(a.id, cfg.connection_id);
    for (const l of due) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      // Reserva o lead por 10 minutos: outra varredura ao mesmo tempo não manda a mesma mensagem.
      const lease = await one(sql, `update prospect_leads set next_at = $2::timestamptz + interval '10 minutes' where id = $1 and next_at <= $2 returning id`, [l.id, now.toISOString()]);
      if (!lease) continue;
      const restore = () => sql.query(`update prospect_leads set next_at = $2 where id = $1`, [l.id, now.toISOString()]);
      const step = cfg.steps[l.step];
      if (!step) { await sql.query(`update prospect_leads set next_at = null where id = $1`, [l.id]); continue; }
      const vars = l.step === 0 ? cfg.variations.filter((v) => v.on) : [];
      const vi = vars.length ? pick(l.id, vars.length) : null;
      const msg = vi !== null ? vars[vi] : step;
      if (!msg.template) {
        await sql.query(`update prospect_leads set stage = 'erro', next_at = null, error = $2 where id = $1`, [l.id, `Falta o modelo aprovado no passo ${l.step + 1}.`]);
        out.failed++;
        continue;
      }
      try {
        await send(l.phone, { kind: "template", name: msg.template, lang: cfg.lang, params: templateParams(msg.text, l) });
      } catch (error) {
        const status = (error as { status?: number }).status;
        const text = error instanceof Error ? error.message : String(error);
        // Limite da Meta (vem como 429 ou como 400 com os códigos 130429, 131056 e 131048): para a agência neste ciclo, sem marcar o lead.
        if (status === 429 || /\b(130429|131056|131048|80007)\b|rate limit|throttl|too many/i.test(text)) { await restore(); break; }
        await sql.query(`update prospect_leads set stage = 'erro', next_at = null, error = $2 where id = $1`, [l.id, (error instanceof Error ? error.message : String(error)).slice(0, 400)]);
        out.failed++;
        continue;
      }
      const next = cfg.steps[l.step + 1];
      await sql.query(`insert into prospect_messages (lead_id, agency_id, dir, text, step, variation, created_at) values ($1, $2, 'out', $3, $4, $5, $6)`,
        [l.id, a.id, fillText(msg.text, l), l.step, vi, now.toISOString()]);
      await sql.query(
        `update prospect_leads set stage = 'abordado', step = $2, last_out_at = $3, next_at = $4, variation = coalesce(variation, $5), error = null where id = $1`,
        [l.id, l.step + 1, now.toISOString(), next ? new Date(now.getTime() + Math.max(1, next.day - step.day) * 864e5).toISOString() : null, vi],
      );
      out.sent++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export async function prospectBoard(sql: Sql, agencyId: string, now = new Date()) {
  const [config, leads, sent, byVar] = await Promise.all([
    getConfig(sql, agencyId),
    sql.query<{ id: string; list_name: string; name: string | null; company: string | null; phone: string; email: string | null; segment: string | null; city: string | null; source: string; website: string | null; origin: string | null; stage: string; step: number; next_at: string | null; variation: number | null; last_out_at: string | null; last_in_at: string | null; read_at: string | null; owner_user: string | null; deal_id: string | null; error: string | null; created_at: string; last_text: string | null }>(
      `select l.id, l.list_name, l.name, l.company, l.phone, l.email, l.segment, l.city, l.source, l.website, l.origin, l.stage, l.step, l.next_at::text, l.variation,
              l.last_out_at::text, l.last_in_at::text, l.read_at::text, l.owner_user, l.deal_id, l.error, l.created_at::text,
              (select text from prospect_messages m where m.lead_id = l.id and m.dir in ('in', 'out') order by m.id desc limit 1) as last_text
         from prospect_leads l where l.agency_id = $1 order by coalesce(l.last_in_at, l.last_out_at, l.created_at) desc limit 3000`,
      [agencyId],
    ),
    sentToday(sql, agencyId, now),
    sql.query<{ variation: number; sent: number; replied: number }>(
      `select variation, count(*)::int as sent, count(*) filter (where last_in_at is not null)::int as replied
         from prospect_leads where agency_id = $1 and variation is not null group by variation`,
      [agencyId],
    ),
  ]);
  const count = (s: string) => leads.filter((l) => l.stage === s).length;
  const contacted = leads.filter((l) => l.last_out_at).length, replied = leads.filter((l) => l.last_in_at).length;
  return {
    config, leads, variations: byVar,
    stats: {
      sent_today: sent, in_window: inWindow(now), contacted, replied, queued: count("fila"),
      qualified: leads.filter((l) => ["qualificado", "reuniao", "crm"].includes(l.stage)).length,
      meetings: leads.filter((l) => ["reuniao", "crm"].includes(l.stage)).length, crm: count("crm"), opted_out: count("saiu"), errors: count("erro"),
      unread: leads.filter((l) => l.last_in_at && (!l.read_at || l.read_at < l.last_in_at)).length,
    },
  };
}

/** Conversa do lead; marca como lida. */
export async function leadMessages(sql: Sql, agencyId: string, id: string, now = new Date()) {
  await leadOf(sql, agencyId, id);
  const rows = await sql.query<{ id: number; dir: string; text: string; step: number | null; variation: number | null; author_name: string | null; created_at: string }>(
    `select m.id, m.dir, m.text, m.step, m.variation, coalesce(p.full_name, u.email) as author_name, m.created_at::text
       from prospect_messages m left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
      where m.lead_id = $1 order by m.id`,
    [id],
  );
  await sql.query(`update prospect_leads set read_at = $2 where id = $1`, [id, now.toISOString()]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Não lidas (para o menu), sem carregar a lista. */
export async function prospectUnread(sql: Sql, agencyId: string) {
  return (await one<{ n: number }>(sql, `select count(*)::int as n from prospect_leads where agency_id = $1 and last_in_at is not null and (read_at is null or read_at < last_in_at)`, [agencyId]))!.n;
}
