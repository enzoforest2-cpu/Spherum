import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import { createUpdate } from "./collab";
import { addTask, createProject } from "./projects";

/**
 * Atas de reunião: a reunião é registrada (cliente, assunto, data), depois a ata é escrita à mão ou
 * por um xodó (ferramenta registrar_ata). Os passos da equipe viram tarefas em Projetos; enviar ao
 * cliente publica a ata em "Feito pela agência" no portal.
 */

const date = z.iso.date();

export const meetingInput = z.object({
  client_id: z.uuid(),
  title: z.string().trim().min(1).max(160),
  meeting_date: date,
  meeting_time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/).nullable().optional(),
  attendees: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
});

export const stepInput = z.object({
  title: z.string().trim().min(1).max(200),
  /** Nome de quem faz: se for alguém da equipe, liga à pessoa. */
  owner: z.string().trim().max(120).nullable().optional(),
  due_date: date.nullable().optional(),
});

export const minutesInput = z.object({
  summary: z.string().trim().min(1).max(4000),
  decisions: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  steps: z.array(stepInput).max(30).optional(),
  attendees: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
});

async function meetingOf(sql: Sql, agencyId: string, id: string) {
  const m = await one<{ id: string; client_id: string; client_name: string; title: string; status: string; summary: string | null; decisions: string[] }>(
    sql,
    `select m.id, m.client_id, c.name as client_name, m.title, m.status, m.summary, m.decisions from meetings m join clients c on c.id = m.client_id where m.id = $1 and m.agency_id = $2`,
    [id, agencyId],
  );
  if (!m) throw new XodoError("Reunião não encontrada.", 404);
  return m;
}

export async function createMeeting(sql: Sql, agencyId: string, userId: string | null, raw: unknown) {
  const input = meetingInput.parse(raw);
  const c = await one(sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [input.client_id, agencyId]);
  if (!c) throw new XodoError("Cliente não encontrado.", 404);
  const row = await one<{ id: string }>(
    sql,
    `insert into meetings (agency_id, client_id, title, meeting_date, meeting_time, attendees, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [agencyId, input.client_id, input.title, input.meeting_date, input.meeting_time ?? null, input.attendees, userId],
  );
  return row!;
}

/** Liga o nome à pessoa da equipe (nome completo ou primeiro nome, sem acento). */
async function teamByName(sql: Sql, agencyId: string) {
  const rows = await sql.query<{ user_id: string; name: string }>(
    `select m.user_id, coalesce(p.full_name, u.email) as name from agency_members m left join profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.agency_id = $1`,
    [agencyId],
  );
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  return (name: string | null | undefined) => {
    if (!name) return null;
    const n = norm(name);
    return rows.find((r) => r.name && norm(r.name) === n)?.user_id ?? rows.find((r) => r.name && norm(r.name).split(/\s+/)[0] === n.split(/\s+/)[0])?.user_id ?? null;
  };
}

/** Escreve (ou reescreve) a ata. Os passos informados substituem os que ainda não viraram tarefa. */
export async function writeMinutes(sql: Sql, agencyId: string, actor: { userId?: string | null; xodoId?: string | null }, id: string, raw: unknown) {
  const input = minutesInput.parse(raw);
  const m = await meetingOf(sql, agencyId, id);
  await sql.query(
    `update meetings set summary = $3, decisions = $4, attendees = coalesce($5, attendees), status = case when status = 'enviada' then 'enviada' else 'rascunho' end,
            written_by_xodo = coalesce($6, written_by_xodo) where id = $1 and agency_id = $2`,
    [id, agencyId, input.summary, input.decisions, input.attendees ?? null, actor.xodoId ?? null],
  );
  if (input.steps) {
    const who = await teamByName(sql, agencyId);
    await sql.query(`delete from meeting_steps where meeting_id = $1 and task_id is null`, [id]);
    let pos = (await one<{ n: number }>(sql, `select coalesce(max(position) + 1, 0)::int as n from meeting_steps where meeting_id = $1`, [id]))!.n;
    for (const s of input.steps) {
      const user = who(s.owner);
      await sql.query(
        `insert into meeting_steps (meeting_id, agency_id, title, owner_user, owner_name, due_date, position) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, agencyId, s.title, user, user ? null : s.owner ?? null, s.due_date ?? null, pos++],
      );
    }
  }
  if (actor.userId) await audit(sql, { agencyId, actor: actor.userId, action: "ata_escrita", targetType: "meeting", targetId: id });
  return { id, client: m.client_name };
}

export async function toggleStep(sql: Sql, agencyId: string, meetingId: string, stepId: string, done: boolean) {
  await meetingOf(sql, agencyId, meetingId);
  const s = await one<{ task_id: string | null }>(sql, `update meeting_steps set done = $3 where id = $1 and meeting_id = $2 returning task_id`, [stepId, meetingId, done]);
  if (!s) throw new XodoError("Passo não encontrado.", 404);
  // O passo e a tarefa andam juntos.
  if (s.task_id) await sql.query(`update project_tasks set done = $2, done_at = case when $2 then coalesce(done_at, now()) else null end where id = $1`, [s.task_id, done]);
}

/** Passos da equipe ainda sem tarefa viram tarefas no projeto "Combinados · cliente". */
export async function stepsToTasks(sql: Sql, agencyId: string, userId: string, meetingId: string, now = new Date()) {
  const m = await meetingOf(sql, agencyId, meetingId);
  const steps = await sql.query<{ id: string; title: string; owner_user: string | null; due_date: string | null }>(
    `select id, title, owner_user, due_date::text from meeting_steps where meeting_id = $1 and task_id is null and not done and owner_user is not null order by position`,
    [meetingId],
  );
  if (!steps.length) return { created: 0, project_id: null };
  const name = `Combinados · ${m.client_name}`.slice(0, 160);
  let project = await one<{ id: string; due_date: string }>(sql, `select id, due_date::text from projects where agency_id = $1 and client_id = $2 and name = $3 and status <> 'done'`, [agencyId, m.client_id, name]);
  const lastDue = steps.reduce((d, s) => (s.due_date && s.due_date > d ? s.due_date : d), new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10));
  if (!project) {
    const p = await createProject(sql, agencyId, userId, { name, client_id: m.client_id, owner_user: userId, tags: ["Reunião"], due_date: lastDue }, now);
    project = { id: p.id, due_date: lastDue };
  } else if (lastDue > project.due_date) {
    await sql.query(`update projects set due_date = $2 where id = $1`, [project.id, lastDue]);
  }
  for (const s of steps) {
    const t = await addTask(sql, agencyId, project.id, { title: `${s.title} (reunião: ${m.title})`.slice(0, 200), assignee_user: s.owner_user, due_date: s.due_date });
    await sql.query(`update meeting_steps set task_id = $2 where id = $1`, [s.id, t.id]);
  }
  return { created: steps.length, project_id: project.id };
}

/** Envia a ata ao cliente: fica em "Feito pela agência" no portal (os e-mails, a rota manda). */
export async function sendMinutes(sql: Sql, agencyId: string, userId: string, meetingId: string) {
  const m = await meetingOf(sql, agencyId, meetingId);
  if (m.status === "sem_ata" || !m.summary) throw new XodoError("Escreva a ata antes de enviar.", 409);
  const why = [m.summary, ...(m.decisions.length ? ["Decidimos: " + m.decisions.join("; ")] : [])].join(" ").slice(0, 600);
  if (m.status !== "enviada") await createUpdate(sql, agencyId, userId, m.client_id, { title: `Ata: ${m.title}`.slice(0, 200), why, kind: "equipe", publish: true });
  await sql.query(`update meetings set status = 'enviada', sent_at = now() where id = $1`, [meetingId]);
  await audit(sql, { agencyId, actor: userId, action: "ata_enviada", targetType: "meeting", targetId: meetingId });
  return m;
}

export async function deleteMeeting(sql: Sql, agencyId: string, userId: string, id: string) {
  await meetingOf(sql, agencyId, id);
  await sql.query(`delete from meetings where id = $1`, [id]);
  await audit(sql, { agencyId, actor: userId, action: "reuniao_excluida", targetType: "meeting", targetId: id });
}

export async function listMeetings(sql: Sql, agencyId: string) {
  const [meetings, steps] = await Promise.all([
    sql.query<{ id: string; client_id: string; client_name: string; title: string; meeting_date: string; meeting_time: string | null; attendees: string[]; summary: string | null; decisions: string[]; status: string; xodo_name: string | null; sent_at: string | null; created_at: string }>(
      `select m.id, m.client_id, c.name as client_name, m.title, m.meeting_date::text, m.meeting_time, m.attendees, m.summary, m.decisions, m.status, x.name as xodo_name, m.sent_at::text, m.created_at::text
         from meetings m join clients c on c.id = m.client_id left join xodos x on x.id = m.written_by_xodo
        where m.agency_id = $1 order by m.meeting_date desc, m.created_at desc limit 200`,
      [agencyId],
    ),
    sql.query<{ id: string; meeting_id: string; title: string; owner_user: string | null; owner: string | null; due_date: string | null; done: boolean; task_id: string | null }>(
      `select s.id, s.meeting_id, s.title, s.owner_user, coalesce(p.full_name, u.email, s.owner_name) as owner, s.due_date::text, s.done, s.task_id
         from meeting_steps s left join profiles p on p.id = s.owner_user left join auth.users u on u.id = s.owner_user
        where s.agency_id = $1 order by s.position`,
      [agencyId],
    ),
  ]);
  return meetings.map((m) => ({ ...m, steps: steps.filter((s) => s.meeting_id === m.id) }));
}
