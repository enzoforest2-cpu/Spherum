import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { createDeal } from "./crm";

/**
 * Formulários públicos que alimentam o CRM. Cada resposta vira um negócio na etapa escolhida, com
 * as respostas nas observações. Campos com condição só valem quando a condição bate.
 */

const field = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/i),
  t: z.enum(["text", "phone", "email", "choice"]),
  l: z.string().trim().min(1).max(200),
  req: z.boolean().default(false),
  opts: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  cond: z.tuple([z.string(), z.string()]).optional(),
  // Papel do campo no negócio (senão, é deduzido pelo tipo e pela pergunta).
  role: z.enum(["empresa", "contato", "email", "telefone", "segmento", "site"]).optional(),
});

export const formInput = z.object({
  name: z.string().trim().min(1).max(120),
  fields: z.array(field).max(40).default([
    { id: "nome", t: "text", l: "Seu nome", req: true },
    { id: "wa", t: "phone", l: "WhatsApp", req: true },
  ]),
  cta: z.string().trim().min(1).max(60).default("Enviar"),
  thanks: z.string().trim().max(300).nullable().optional(),
  deal_stage: z.enum(["novo", "contato", "diagnostico"]).default("novo"),
  owner_user: z.uuid().nullable().optional(),
  notify: z.boolean().default(true),
  active: z.boolean().default(true),
});
export const formPatch = formInput.partial();

const code = () => randomBytes(8).toString("hex").slice(0, 10);

export async function createForm(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = formInput.parse(raw);
  const row = await one<{ id: string; code: string }>(
    sql,
    `insert into forms (agency_id, code, name, fields, cta, thanks, deal_stage, owner_user, notify, active, created_by)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) returning id, code`,
    [agencyId, code(), input.name, json(input.fields), input.cta, input.thanks ?? null, input.deal_stage, input.owner_user ?? userId, input.notify, input.active, userId],
  );
  return row!;
}

export async function updateForm(sql: Sql, agencyId: string, id: string, raw: unknown) {
  const input = formPatch.parse(raw);
  if (!(await one(sql, `select 1 from forms where id = $1 and agency_id = $2`, [id, agencyId]))) throw new XodoError("Formulário não encontrado.", 404);
  const sets: string[] = [], vals: unknown[] = [id];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    vals.push(k === "fields" ? json(v) : v);
    sets.push(`${k} = $${vals.length}${k === "fields" ? "::jsonb" : ""}`);
  }
  if (sets.length) await sql.query(`update forms set ${sets.join(", ")} where id = $1`, vals);
}

export async function deleteForm(sql: Sql, agencyId: string, id: string) {
  const r = await one(sql, `delete from forms where id = $1 and agency_id = $2 returning id`, [id, agencyId]);
  if (!r) throw new XodoError("Formulário não encontrado.", 404);
}

export async function listForms(sql: Sql, agencyId: string, now = new Date()) {
  const [forms, subs] = await Promise.all([
    sql.query<{ id: string; code: string; name: string; fields: unknown[]; cta: string; thanks: string | null; deal_stage: string; owner_user: string | null; notify: boolean; active: boolean; views: number; created_at: string }>(
      `select id, code, name, fields, cta, thanks, deal_stage, owner_user, notify, active, views, created_at::text from forms where agency_id = $1 order by created_at`,
      [agencyId],
    ),
    sql.query<{ id: string; form_id: string; answers: Record<string, string>; deal_id: string | null; created_at: string }>(
      `select id, form_id, answers, deal_id, created_at::text from form_submissions where agency_id = $1 and created_at > $2::timestamptz - interval '90 days' order by created_at desc limit 500`,
      [agencyId, now.toISOString()],
    ),
  ]);
  return forms.map((f) => ({ ...f, submissions: subs.filter((s) => s.form_id === f.id) }));
}

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------

type Field = z.infer<typeof field>;

async function byCode(sql: Sql, formCode: string) {
  if (!/^[a-z0-9]{8,16}$/.test(formCode)) return null;
  return one<{ id: string; agency_id: string; agency_name: string; brand_color: string | null; name: string; fields: Field[]; cta: string; thanks: string | null; deal_stage: string; owner_user: string | null; notify: boolean; active: boolean }>(
    sql,
    `select f.id, f.agency_id, a.name as agency_name, a.brand_color, f.name, f.fields, f.cta, f.thanks, f.deal_stage, f.owner_user, f.notify, f.active
       from forms f join agencies a on a.id = f.agency_id where f.code = $1`,
    [formCode],
  );
}

/** O formulário como o público vê (conta a visita). */
export async function publicForm(sql: Sql, formCode: string, count = true) {
  const f = await byCode(sql, formCode);
  if (!f || !f.active) throw new XodoError("Formulário não encontrado.", 404);
  if (count) await sql.query(`update forms set views = views + 1 where id = $1`, [f.id]);
  return { name: f.name, agency: f.agency_name, color: f.brand_color, cta: f.cta, thanks: f.thanks, fields: f.fields.map(({ role: _r, ...x }) => (void _r, x)) };
}

const roleOf = (f: Field) => {
  if (f.role) return f.role;
  const l = f.l.toLowerCase();
  if (f.t === "email") return "email";
  if (f.t === "phone") return "telefone";
  if (/empresa|neg[óo]cio|marca|loja/.test(l)) return "empresa";
  if (/nome/.test(l)) return "contato";
  if (/segmento|ramo|setor/.test(l)) return "segmento";
  if (/site|instagram/.test(l)) return "site";
  return null;
};

/** Resposta do público: confere os campos, guarda e cria o negócio no CRM. */
export async function submitForm(sql: Sql, formCode: string, raw: unknown, ip: string | null, salt: string, now = new Date()) {
  const f = await byCode(sql, formCode);
  if (!f || !f.active) throw new XodoError("Formulário não encontrado.", 404);
  const body = z.record(z.string(), z.string().max(2000)).parse(raw);
  const ipHash = ip ? createHash("sha256").update(`${salt}:${ip}`).digest("hex") : null;
  if (ipHash) {
    const recent = await one<{ n: number }>(sql, `select count(*)::int as n from form_submissions where form_id = $1 and ip_hash = $2 and created_at > $3::timestamptz - interval '1 hour'`, [f.id, ipHash, now.toISOString()]);
    if ((recent?.n ?? 0) >= 10) throw new XodoError("Muitas respostas seguidas. Tente de novo mais tarde.", 429);
  }
  const answers: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const x of f.fields) {
    if (x.cond && (body[x.cond[0]] ?? "") !== x.cond[1]) continue;
    const v = (body[x.id] ?? "").trim();
    if (!v) { if (x.req) errors[x.id] = "Campo obrigatório"; continue; }
    if ((x.t === "email" || roleOf(x) === "email") && !z.email().safeParse(v).success) errors[x.id] = "E-mail inválido";
    else if (x.t === "phone" && v.replace(/\D/g, "").length < 10) errors[x.id] = "Telefone incompleto";
    else if (x.t === "choice" && x.opts && !x.opts.includes(v)) errors[x.id] = "Escolha uma das opções";
    else answers[x.id] = v;
  }
  if (Object.keys(errors).length) throw Object.assign(new XodoError("Confira os campos destacados.", 400), { fields: errors });
  const by = (role: string) => f.fields.find((x) => roleOf(x) === role && answers[x.id]);
  const get = (role: string) => { const x = by(role); return x ? answers[x.id] : null; };
  const company = get("empresa") ?? get("contato") ?? "Lead do formulário";
  const notes = [`Formulário "${f.name}"`, ...f.fields.filter((x) => answers[x.id]).map((x) => `${x.l}: ${answers[x.id]}`)].join("\n").slice(0, 4000);
  // Dono do formulário que saiu da equipe não pode ser responsável pelo negócio: cai para o dono da agência.
  const ownerStill = f.owner_user ? await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [f.agency_id, f.owner_user]) : null;
  const owner: string = ownerStill && f.owner_user ? f.owner_user : (await one<{ user_id: string }>(sql, `select user_id from agency_members where agency_id = $1 and role = 'owner' order by created_at limit 1`, [f.agency_id]))!.user_id;
  const actor = owner;
  const deal = await createDeal(sql, f.agency_id, actor, {
    company: company.slice(0, 160), contact_name: get("contato")?.slice(0, 120) ?? null, email: get("email"), phone: get("telefone")?.slice(0, 40) ?? null,
    segment: get("segmento")?.slice(0, 80) ?? null, website: get("site")?.slice(0, 200) ?? null, source: "Formulário", stage: f.deal_stage, owner_user: owner, notes,
    next_action: "Responder o lead do formulário", next_action_date: now.toISOString().slice(0, 10),
  });
  await sql.query(`insert into form_submissions (form_id, agency_id, answers, deal_id, ip_hash) values ($1, $2, $3::jsonb, $4, $5)`, [f.id, f.agency_id, json(answers), deal.id, ipHash]);
  if (f.notify) {
    await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'lead_formulario', $2, $3::jsonb)`, [f.agency_id, `Novo lead: ${company} (${f.name})`.slice(0, 200), json({ form_id: f.id, deal_id: deal.id })]);
  }
  return { ok: true, thanks: f.thanks };
}
