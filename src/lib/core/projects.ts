import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";

/**
 * Projetos da agência (Projetos: lista, quadro, linha do tempo e calendário) e as tarefas de cada
 * um. Um playbook cria as tarefas com prazos relativos ao início. Com tarefas, o progresso é a
 * fração concluída; sem tarefas, a equipe informa o progresso à mão.
 */

export const PROJECT_STATUS = ["todo", "doing", "review", "done"] as const;
export const PROJECT_PRIORITY = ["alta", "media", "baixa"] as const;

/** Playbooks: [título da tarefa, dias depois do início]. */
export const PLAYBOOKS: Record<string, { label: string; tasks: [string, number][] }> = {
  campanha: {
    label: "Nova campanha",
    tasks: [
      ["Briefing com o cliente", 0], ["Definir públicos e verba", 1], ["Produzir os criativos", 2], ["Escrever as copies", 2],
      ["Aprovação do cliente", 3], ["Conferir o tracking", 3], ["Subir a campanha", 4], ["Primeira revisão de resultados", 5],
    ],
  },
  relatorio: {
    label: "Relatório mensal",
    tasks: [["Puxar os números do mês", 0], ["Analisar o que mudou", 1], ["Escrever o relatório", 2], ["Revisão interna", 3], ["Publicar no portal do cliente", 4]],
  },
  onboarding: {
    label: "Onboarding de cliente",
    tasks: [
      ["Reunião de boas-vindas", 0], ["Contrato assinado", 0], ["Cobrança recorrente criada", 1], ["Convite para o portal do cliente", 1],
      ["Acesso ao Meta Business", 2], ["Acesso ao Google Ads", 2], ["Acesso ao Google Analytics", 2], ["Pixel e conversões instalados", 4],
      ["Tracking validado", 5], ["Briefing de marca e público", 5], ["Metas combinadas", 6], ["Plano da primeira campanha", 7],
      ["Primeira campanha no ar", 8], ["Primeira reunião de resultados", 9],
    ],
  },
};

const date = z.iso.date();

export const projectInput = z.object({
  name: z.string().trim().min(1).max(160),
  client_id: z.uuid().nullable().optional(),
  description: z.string().trim().max(4000).optional(),
  owner_user: z.uuid().nullable().optional(),
  priority: z.enum(PROJECT_PRIORITY).default("media"),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  start_date: date.optional(),
  due_date: date,
  playbook: z.enum(Object.keys(PLAYBOOKS) as [string, ...string[]]).optional(),
});

export const projectPatch = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  client_id: z.uuid().nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  owner_user: z.uuid().nullable().optional(),
  status: z.enum(PROJECT_STATUS).optional(),
  priority: z.enum(PROJECT_PRIORITY).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  start_date: date.optional(),
  due_date: date.optional(),
  progress: z.number().int().min(0).max(100).optional(),
});

export const taskInput = z.object({
  title: z.string().trim().min(1).max(200),
  assignee_user: z.uuid().nullable().optional(),
  due_date: date.nullable().optional(),
});

export const taskPatch = taskInput.partial().extend({ done: z.boolean().optional(), position: z.number().int().min(0).max(10_000).optional() });

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function checkMember(sql: Sql, agencyId: string, userId: string | null | undefined) {
  if (!userId) return;
  const m = await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, userId]);
  if (!m) throw new XodoError("Essa pessoa não é da equipe.", 400);
}

async function checkClient(sql: Sql, agencyId: string, clientId: string | null | undefined) {
  if (!clientId) return;
  const c = await one(sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [clientId, agencyId]);
  if (!c) throw new XodoError("Cliente não encontrado.", 404);
}

/** Hoje no fuso da agência (para "atrasado" e para o início padrão). */
async function agencyToday(sql: Sql, agencyId: string, now = new Date()) {
  const a = await one<{ timezone: string | null }>(sql, `select timezone from agencies where id = $1`, [agencyId]);
  return now.toLocaleDateString("en-CA", { timeZone: a?.timezone || "America/Sao_Paulo" });
}

export async function createProject(sql: Sql, agencyId: string, userId: string, raw: unknown, now = new Date()) {
  const input = projectInput.parse(raw);
  await checkClient(sql, agencyId, input.client_id);
  await checkMember(sql, agencyId, input.owner_user);
  const start = input.start_date ?? (await agencyToday(sql, agencyId, now));
  if (input.due_date < start) throw new XodoError("O prazo vem depois do início.", 400);
  const row = await one<{ id: string }>(
    sql,
    `insert into projects (agency_id, client_id, name, description, owner_user, priority, tags, start_date, due_date, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [agencyId, input.client_id ?? null, input.name, input.description ?? null, input.owner_user ?? null, input.priority, input.tags, start, input.due_date, userId],
  );
  if (input.playbook) {
    const pb = PLAYBOOKS[input.playbook];
    // Os prazos do playbook nunca passam do prazo do projeto.
    let pos = 0;
    for (const [title, days] of pb.tasks) {
      const due = addDays(start, days);
      await sql.query(
        `insert into project_tasks (project_id, agency_id, title, assignee_user, due_date, position) values ($1, $2, $3, $4, $5, $6)`,
        [row!.id, agencyId, title, input.owner_user ?? null, due > input.due_date ? input.due_date : due, pos++],
      );
    }
  }
  await audit(sql, { agencyId, actor: userId, action: "projeto_criado", targetType: "project", targetId: row!.id });
  return row!;
}

async function projectOf(sql: Sql, agencyId: string, id: string) {
  const p = await one<{ id: string; start_date: string; due_date: string; status: string }>(
    sql,
    `select id, start_date::text, due_date::text, status from projects where id = $1 and agency_id = $2`,
    [id, agencyId],
  );
  if (!p) throw new XodoError("Projeto não encontrado.", 404);
  return p;
}

export async function updateProject(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown) {
  const input = projectPatch.parse(raw);
  const p = await projectOf(sql, agencyId, id);
  await checkClient(sql, agencyId, input.client_id);
  await checkMember(sql, agencyId, input.owner_user);
  const start = input.start_date ?? p.start_date, due = input.due_date ?? p.due_date;
  if (due < start) throw new XodoError("O prazo vem depois do início.", 400);
  const sets: string[] = [], vals: unknown[] = [id, agencyId];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const k of ["name", "client_id", "description", "owner_user", "priority", "tags", "start_date", "due_date", "progress"] as const) {
    if (input[k] !== undefined) set(k, input[k]);
  }
  if (input.status !== undefined) {
    set("status", input.status);
    sets.push(input.status === "done" ? `done_at = coalesce(done_at, now())` : `done_at = null`);
    if (input.status === "done" && input.progress === undefined) sets.push(`progress = 100`);
  }
  if (!sets.length) return;
  await sql.query(`update projects set ${sets.join(", ")} where id = $1 and agency_id = $2`, vals);
  if (input.status && input.status !== p.status) {
    await audit(sql, { agencyId, actor: userId, action: `projeto_${input.status}`, targetType: "project", targetId: id });
  }
}

export async function deleteProject(sql: Sql, agencyId: string, userId: string, id: string) {
  await projectOf(sql, agencyId, id);
  await sql.query(`delete from projects where id = $1 and agency_id = $2`, [id, agencyId]);
  await audit(sql, { agencyId, actor: userId, action: "projeto_excluido", targetType: "project", targetId: id });
}

export async function listTasks(sql: Sql, agencyId: string, projectId: string) {
  await projectOf(sql, agencyId, projectId);
  return sql.query<{ id: string; title: string; assignee_user: string | null; assignee_name: string | null; due_date: string | null; position: number; done: boolean; done_at: string | null }>(
    `select t.id, t.title, t.assignee_user, coalesce(p.full_name, u.email) as assignee_name, t.due_date::text, t.position, t.done, t.done_at::text
       from project_tasks t left join profiles p on p.id = t.assignee_user left join auth.users u on u.id = t.assignee_user
      where t.project_id = $1 order by t.position, t.created_at`,
    [projectId],
  );
}

export async function addTask(sql: Sql, agencyId: string, projectId: string, raw: unknown) {
  const input = taskInput.parse(raw);
  await projectOf(sql, agencyId, projectId);
  await checkMember(sql, agencyId, input.assignee_user);
  const row = await one<{ id: string }>(
    sql,
    `insert into project_tasks (project_id, agency_id, title, assignee_user, due_date, position)
     values ($1, $2, $3, $4, $5, coalesce((select max(position) + 1 from project_tasks where project_id = $1), 0)) returning id`,
    [projectId, agencyId, input.title, input.assignee_user ?? null, input.due_date ?? null],
  );
  return row!;
}

export async function updateTask(sql: Sql, agencyId: string, userId: string, projectId: string, taskId: string, raw: unknown) {
  const input = taskPatch.parse(raw);
  await projectOf(sql, agencyId, projectId);
  await checkMember(sql, agencyId, input.assignee_user);
  const sets: string[] = [], vals: unknown[] = [taskId, projectId];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const k of ["title", "assignee_user", "due_date", "position"] as const) if (input[k] !== undefined) set(k, input[k]);
  if (input.done !== undefined) {
    set("done", input.done);
    if (input.done) { vals.push(userId); sets.push(`done_at = coalesce(done_at, now())`, `done_by = $${vals.length}`); }
    else sets.push(`done_at = null`, `done_by = null`);
  }
  if (!sets.length) return;
  const row = await one(sql, `update project_tasks set ${sets.join(", ")} where id = $1 and project_id = $2 returning id`, vals);
  if (!row) throw new XodoError("Tarefa não encontrada.", 404);
}

export async function deleteTask(sql: Sql, agencyId: string, projectId: string, taskId: string) {
  await projectOf(sql, agencyId, projectId);
  const row = await one(sql, `delete from project_tasks where id = $1 and project_id = $2 returning id`, [taskId, projectId]);
  if (!row) throw new XodoError("Tarefa não encontrada.", 404);
}

/** Projetos da agência para a tela, com o progresso e o "atrasado" já calculados. */
export async function listProjects(sql: Sql, agencyId: string, now = new Date()) {
  const today = await agencyToday(sql, agencyId, now);
  const rows = await sql.query<{
    id: string; client_id: string | null; name: string; description: string | null; owner_user: string | null; owner_name: string | null; status: string; priority: string;
    tags: string[]; start_date: string; due_date: string; progress: number; done_at: string | null; created_at: string; tasks_total: number; tasks_done: number; next_task: string | null;
  }>(
    `select pr.id, pr.client_id, pr.name, pr.description, pr.owner_user, coalesce(p.full_name, u.email) as owner_name, pr.status, pr.priority, pr.tags,
            pr.start_date::text, pr.due_date::text, pr.progress, pr.done_at::text, pr.created_at::text,
            (select count(*)::int from project_tasks t where t.project_id = pr.id) as tasks_total,
            (select count(*)::int from project_tasks t where t.project_id = pr.id and t.done) as tasks_done,
            (select t.title from project_tasks t where t.project_id = pr.id and not t.done order by t.position, t.created_at limit 1) as next_task
       from projects pr left join profiles p on p.id = pr.owner_user left join auth.users u on u.id = pr.owner_user
      where pr.agency_id = $1 order by pr.due_date, pr.created_at`,
    [agencyId],
  );
  return rows.map((r) => ({
    ...r,
    progress: r.status === "done" ? 100 : r.tasks_total ? Math.round((r.tasks_done / r.tasks_total) * 100) : r.progress,
    late: r.status !== "done" && r.due_date < today,
  }));
}

/** Carga de cada pessoa: projetos ativos de que é responsável e tarefas abertas com ela. */
export async function teamLoad(sql: Sql, agencyId: string) {
  const rows = await sql.query<{ user_id: string; projects: number; tasks: number }>(
    `select m.user_id,
            (select count(*)::int from projects p where p.agency_id = $1 and p.owner_user = m.user_id and p.status <> 'done') as projects,
            (select count(*)::int from project_tasks t join projects p on p.id = t.project_id
              where t.agency_id = $1 and t.assignee_user = m.user_id and not t.done and p.status <> 'done') as tasks
       from agency_members m where m.agency_id = $1`,
    [agencyId],
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, { projects: r.projects, tasks: r.tasks }]));
}
