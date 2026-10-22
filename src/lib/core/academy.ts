import { randomBytes } from "node:crypto";
import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { addTask, createProject } from "./projects";

/**
 * Academy: trilhas (aulas; cada pessoa marca as suas), processos (passo a passo da agência, que pode
 * virar tarefas num projeto) e onboarding de colaborador (checklist por fase, cada passo com
 * responsável; o progresso é um só).
 */

export const KINDS = ["trilha", "processo", "onboarding"] as const;
type Kind = (typeof KINDS)[number];

const stepId = () => randomBytes(5).toString("hex");
const step = z.object({
  id: z.string().regex(/^[a-z0-9]{4,20}$/).optional(),
  title: z.string().trim().min(1).max(200),
  sub: z.string().trim().max(120).nullable().optional(),
  url: z.url({ protocol: /^https$/ }).max(500).nullable().optional(),
  group: z.string().trim().max(60).nullable().optional(),
  owner_user: z.uuid().nullable().optional(),
});

export const itemInput = z.object({
  kind: z.enum(KINDS),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  steps: z.array(step).max(80).default([]),
  hire_name: z.string().trim().max(120).nullable().optional(),
  hire_role: z.string().trim().max(80).nullable().optional(),
  start_date: z.iso.date().nullable().optional(),
});
export const itemPatch = itemInput.omit({ kind: true }).partial();

/** Passos padrão do onboarding de quem chega (a agência edita depois). */
export function onboardingSteps(hire: string, ownerId: string | null, trail?: string) {
  return [
    ["Antes do 1º dia", "Criar e-mail e acesso ao Spherum"],
    ["Antes do 1º dia", "Enviar boas-vindas com a agenda da semana"],
    ["Semana 1", trail ? `Trilha ${trail}` : "Conhecer os processos da agência"],
    ["Semana 1", "Conhecer os principais clientes"],
    ["Semana 1", "Acompanhar uma reunião de resultados"],
    ["Primeiros 30 dias", "Primeira entrega sozinho"],
    ["Primeiros 30 dias", "Conversa de 30 dias"],
  ].map(([group, title], i) => ({ id: stepId(), group, title, owner_user: i === 2 || i === 5 ? null : ownerId, sub: i === 2 || i === 5 ? hire : null }));
}

async function checkOwners(sql: Sql, agencyId: string, steps: { owner_user?: string | null }[]) {
  const ids = [...new Set(steps.map((s) => s.owner_user).filter(Boolean))] as string[];
  if (!ids.length) return;
  const ok = await sql.query(`select user_id from agency_members where agency_id = $1 and user_id = any($2::uuid[])`, [agencyId, ids]);
  if (ok.length !== ids.length) throw new XodoError("Um responsável não é da equipe.", 400);
}

const withIds = (steps: z.infer<typeof step>[]) => {
  const seen = new Set<string>();
  return steps.map((s) => { let id = s.id && !seen.has(s.id) ? s.id : stepId(); while (seen.has(id)) id = stepId(); seen.add(id); return { ...s, id }; });
};

export async function createItem(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const i = itemInput.parse(raw);
  if (i.kind === "onboarding" && !i.hire_name) throw new XodoError("Diga quem está chegando.", 400);
  const steps = withIds(i.kind === "onboarding" && !i.steps.length ? onboardingSteps(i.hire_name!, userId) : i.steps);
  await checkOwners(sql, agencyId, steps);
  if (i.kind !== "onboarding" && (await one(sql, `select 1 from academy_items where agency_id = $1 and kind = $2 and lower(name) = lower($3)`, [agencyId, i.kind, i.name]))) {
    throw new XodoError(`Já existe ${i.kind === "trilha" ? "uma trilha" : "um processo"} com esse nome.`, 409);
  }
  return (await one<{ id: string }>(
    sql,
    `insert into academy_items (agency_id, kind, name, description, steps, hire_name, hire_role, start_date, created_by) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) returning id`,
    [agencyId, i.kind, i.name, i.description ?? null, json(steps), i.hire_name ?? null, i.hire_role ?? null, i.start_date ?? null, userId],
  ))!;
}

async function itemOf(sql: Sql, agencyId: string, id: string) {
  const it = await one<{ id: string; kind: Kind; name: string; steps: (z.infer<typeof step> & { id: string })[]; hire_name: string | null }>(
    sql, `select id, kind, name, steps, hire_name from academy_items where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!it) throw new XodoError("Item não encontrado.", 404);
  return it;
}

export async function updateItem(sql: Sql, agencyId: string, id: string, raw: unknown) {
  const i = itemPatch.parse(raw);
  await itemOf(sql, agencyId, id);
  const sets: string[] = [], vals: unknown[] = [id];
  if (i.steps) {
    const steps = withIds(i.steps);
    await checkOwners(sql, agencyId, steps);
    vals.push(json(steps)); sets.push(`steps = $${vals.length}::jsonb`);
    // Progresso de passos que saíram vai junto.
    await sql.query(`delete from academy_progress where item_id = $1 and not (step_id = any($2::text[]))`, [id, steps.map((s) => s.id)]);
  }
  for (const k of ["name", "description", "hire_name", "hire_role", "start_date"] as const) {
    if (i[k] === undefined) continue;
    vals.push(i[k]); sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length) await sql.query(`update academy_items set ${sets.join(", ")} where id = $1`, vals);
}

export async function deleteItem(sql: Sql, agencyId: string, id: string) {
  await itemOf(sql, agencyId, id);
  await sql.query(`delete from academy_items where id = $1`, [id]);
}

/** Marca ou desmarca um passo. Trilha: o passo de quem marcou; onboarding: o passo de todos. */
export async function toggleStep(sql: Sql, agencyId: string, userId: string, id: string, stepIdValue: string, done: boolean) {
  const it = await itemOf(sql, agencyId, id);
  if (it.kind === "processo") throw new XodoError("Processo não tem progresso: use como checklist num projeto.", 400);
  if (!it.steps.some((s) => s.id === stepIdValue)) throw new XodoError("Passo não encontrado.", 404);
  const who = it.kind === "trilha" ? userId : null;
  await sql.query(`delete from academy_progress where item_id = $1 and step_id = $2 and user_id is not distinct from $3::uuid`, [id, stepIdValue, who]);
  if (done) await sql.query(`insert into academy_progress (item_id, agency_id, step_id, user_id, done_by) values ($1, $2, $3, $4, $5)`, [id, agencyId, stepIdValue, who, userId]);
}

/** Atribui a trilha a alguém da equipe, com prazo; a pessoa recebe um aviso. */
export async function assignTrail(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown) {
  const i = z.object({ user_id: z.uuid(), due_date: z.iso.date().nullable().optional() }).parse(raw);
  const it = await itemOf(sql, agencyId, id);
  if (it.kind !== "trilha") throw new XodoError("Só trilhas são atribuídas.", 400);
  await checkOwners(sql, agencyId, [{ owner_user: i.user_id }]);
  await sql.query(
    `insert into academy_assignments (item_id, agency_id, user_id, due_date, assigned_by) values ($1, $2, $3, $4, $5)
     on conflict (item_id, user_id) do update set due_date = excluded.due_date`,
    [id, agencyId, i.user_id, i.due_date ?? null, userId],
  );
  await sql.query(`insert into notifications (agency_id, user_id, kind, title, data) values ($1, $2, 'trilha_atribuida', $3, jsonb_build_object('item_id', $4::text))`,
    [agencyId, i.user_id, `Nova trilha para você: ${it.name}`.slice(0, 200), id]);
}

export async function unassignTrail(sql: Sql, agencyId: string, id: string, user: string) {
  await sql.query(`delete from academy_assignments where item_id = $1 and agency_id = $2 and user_id = $3`, [id, agencyId, user]);
}

/** Processo vira tarefas num projeto novo (do cliente, se escolhido), com o prazo final. */
export async function processToProject(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown, now = new Date()) {
  const i = z.object({ client_id: z.uuid().nullable().optional(), due_date: z.iso.date(), owner_user: z.uuid().nullable().optional() }).parse(raw);
  const it = await itemOf(sql, agencyId, id);
  if (it.kind !== "processo") throw new XodoError("Só processos viram checklist.", 400);
  if (!it.steps.length) throw new XodoError("O processo ainda não tem passos.", 400);
  const client = i.client_id ? await one<{ name: string }>(sql, `select name from clients where id = $1 and agency_id = $2`, [i.client_id, agencyId]) : null;
  const p = await createProject(sql, agencyId, userId, { name: `${it.name}${client ? ` · ${client.name}` : ""}`.slice(0, 160), client_id: i.client_id ?? null, owner_user: i.owner_user ?? userId, due_date: i.due_date, tags: ["Processo"] }, now);
  for (const s of it.steps) await addTask(sql, agencyId, p.id, { title: s.title.slice(0, 200), assignee_user: s.owner_user ?? null, due_date: i.due_date });
  return { project_id: p.id, tasks: it.steps.length };
}

/** Lembrete do onboarding: cada responsável com passo pendente recebe um aviso. */
export async function remindOnboarding(sql: Sql, agencyId: string, id: string) {
  const it = await itemOf(sql, agencyId, id);
  if (it.kind !== "onboarding") throw new XodoError("Só onboarding tem lembrete.", 400);
  const done = new Set((await sql.query<{ step_id: string }>(`select step_id from academy_progress where item_id = $1 and user_id is null`, [id])).map((r) => r.step_id));
  const pending = it.steps.filter((s) => !done.has(s.id));
  const owners = [...new Set(pending.map((s) => s.owner_user).filter(Boolean))] as string[];
  for (const o of owners) {
    const mine = pending.filter((s) => s.owner_user === o);
    await sql.query(`insert into notifications (agency_id, user_id, kind, title, data) values ($1, $2, 'onboarding_pendente', $3, $4::jsonb)`,
      [agencyId, o, `Onboarding de ${it.hire_name}: ${mine.length} passo(s) com você`.slice(0, 200), json({ item_id: id, steps: mine.map((s) => s.title).slice(0, 10) })]);
  }
  return { pending: pending.length, people: owners.length };
}

export async function academyBoard(sql: Sql, agencyId: string, userId: string) {
  const [items, progress, assignments] = await Promise.all([
    sql.query<{ id: string; kind: Kind; name: string; description: string | null; steps: (z.infer<typeof step> & { id: string })[]; hire_name: string | null; hire_role: string | null; start_date: string | null; created_at: string }>(
      `select id, kind, name, description, steps, hire_name, hire_role, start_date::text, created_at::text from academy_items where agency_id = $1 order by created_at`, [agencyId]),
    sql.query<{ item_id: string; step_id: string; user_id: string | null; done_at: string }>(`select item_id, step_id, user_id, done_at::text from academy_progress where agency_id = $1`, [agencyId]),
    sql.query<{ item_id: string; user_id: string; name: string | null; due_date: string | null }>(
      `select a.item_id, a.user_id, coalesce(p.full_name, u.email) as name, a.due_date::text from academy_assignments a
         left join profiles p on p.id = a.user_id left join auth.users u on u.id = a.user_id where a.agency_id = $1`, [agencyId]),
  ]);
  return items.map((it) => {
    const prog = progress.filter((p) => p.item_id === it.id && it.steps.some((s) => s.id === p.step_id));
    const total = it.steps.length;
    if (it.kind === "trilha") {
      const pct = (u: string) => total ? Math.round((prog.filter((p) => p.user_id === u).length / total) * 100) : 0;
      return { ...it, mine: prog.filter((p) => p.user_id === userId).map((p) => p.step_id),
        who: assignments.filter((a) => a.item_id === it.id).map((a) => ({ user_id: a.user_id, name: a.name, due_date: a.due_date, pct: pct(a.user_id) })) };
    }
    return { ...it, done: it.kind === "onboarding" ? prog.filter((p) => p.user_id === null).map((p) => p.step_id) : [] };
  });
}
