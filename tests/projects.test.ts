import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { agencyPortal } from "../src/lib/core/portal";
import {
  addTask, createProject, deleteProject, deleteTask, listProjects, listTasks, PLAYBOOKS, teamLoad, updateProject, updateTask,
} from "../src/lib/core/projects";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let db: PGlite;
let sql: Sql;
before(async () => {
  ({ db, sql } = await createTestDb());
});

async function user(email: string, name?: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(name ? { full_name: name } : {})]))!.id;
}

async function setup() {
  const dona = await user(`dona-${randomUUID()}@x.com`, "Ana Souza");
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Projetos" });
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Sorriso" });
  const bia = await user(`bia-${randomUUID()}@x.com`, "Bia Nunes");
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [agencyId, bia]);
  return { dona, bia, agencyId, clientId: c.id };
}

const NOW = new Date("2026-10-21T15:00:00Z");

test("playbook cria as tarefas com prazos dentro do projeto; progresso vem das tarefas; atrasado pelo fuso da agência", async () => {
  const s = await setup();
  const p = await createProject(sql, s.agencyId, s.dona, {
    name: "Campanha de Natal", client_id: s.clientId, owner_user: s.bia, priority: "alta", tags: ["Campanha"],
    start_date: "2026-10-20", due_date: "2026-10-23", playbook: "campanha",
  }, NOW);
  const tasks = await listTasks(sql, s.agencyId, p.id);
  assert.equal(tasks.length, PLAYBOOKS.campanha.tasks.length);
  assert.deepEqual([tasks[0].title, tasks[0].due_date, tasks[0].assignee_name], ["Briefing com o cliente", "2026-10-20", "Bia Nunes"]);
  assert.ok(tasks.every((t) => t.due_date! <= "2026-10-23"), "nenhuma tarefa passa do prazo do projeto");

  await updateTask(sql, s.agencyId, s.dona, p.id, tasks[0].id, { done: true });
  await updateTask(sql, s.agencyId, s.dona, p.id, tasks[1].id, { done: true });
  let [row] = await listProjects(sql, s.agencyId, NOW);
  assert.deepEqual([row.progress, row.tasks_done, row.tasks_total, row.next_task, row.late, row.owner_name], [25, 2, 8, "Produzir os criativos", false, "Bia Nunes"]);

  // Um dia depois do prazo (no fuso de São Paulo) fica atrasado; concluído nunca atrasa.
  [row] = await listProjects(sql, s.agencyId, new Date("2026-10-24T13:00:00Z"));
  assert.equal(row.late, true);
  await updateProject(sql, s.agencyId, s.dona, p.id, { status: "done" });
  [row] = await listProjects(sql, s.agencyId, new Date("2026-10-24T13:00:00Z"));
  assert.deepEqual([row.status, row.progress, row.late, !!row.done_at], ["done", 100, false, true]);
  await updateProject(sql, s.agencyId, s.dona, p.id, { status: "doing" });
  [row] = await listProjects(sql, s.agencyId, NOW);
  assert.deepEqual([row.progress, row.done_at], [25, null]);

  // Carga da equipe: Bia é responsável pelo projeto e tem as 6 tarefas abertas.
  assert.deepEqual((await teamLoad(sql, s.agencyId))[s.bia], { projects: 1, tasks: 6 });
  const portal = await agencyPortal(sql, s.agencyId, s.dona, NOW);
  assert.equal(portal.projects.length, 1);
  assert.deepEqual(portal.team.filter((m) => m.user_id === s.bia).map((m) => [m.projects, m.tasks]), [[1, 6]]);
});

test("sem tarefas o progresso é manual; validações de prazo, pessoa e cliente; tarefas e exclusão", async () => {
  const s = await setup();
  const outra = await setup();
  const estranho = await user(`x-${randomUUID()}@x.com`);
  await assert.rejects(createProject(sql, s.agencyId, s.dona, { name: "X", start_date: "2026-10-20", due_date: "2026-10-10" }, NOW), /prazo vem depois/);
  await assert.rejects(createProject(sql, s.agencyId, s.dona, { name: "X", due_date: "2026-11-10", owner_user: estranho }, NOW), /não é da equipe/);
  await assert.rejects(createProject(sql, s.agencyId, s.dona, { name: "X", due_date: "2026-11-10", client_id: outra.clientId }, NOW), /Cliente não encontrado/);

  const p = await createProject(sql, s.agencyId, s.dona, { name: "Site novo", due_date: "2026-11-10" }, NOW);
  let [row] = await listProjects(sql, s.agencyId, NOW);
  assert.deepEqual([row.start_date, row.client_id, row.progress, row.status, row.priority], ["2026-10-21", null, 0, "todo", "media"]);
  await updateProject(sql, s.agencyId, s.dona, p.id, { progress: 40, status: "review" });
  [row] = await listProjects(sql, s.agencyId, NOW);
  assert.deepEqual([row.progress, row.status], [40, "review"]);
  await assert.rejects(updateProject(sql, s.agencyId, s.dona, p.id, { due_date: "2026-10-01" }), /prazo vem depois/);
  await assert.rejects(updateProject(sql, outra.agencyId, outra.dona, p.id, { name: "roubado" }), /Projeto não encontrado/);

  const t1 = await addTask(sql, s.agencyId, p.id, { title: "Wireframe", assignee_user: s.dona });
  const t2 = await addTask(sql, s.agencyId, p.id, { title: "Layout" });
  assert.deepEqual((await listTasks(sql, s.agencyId, p.id)).map((t) => [t.title, t.position]), [["Wireframe", 0], ["Layout", 1]]);
  await updateTask(sql, s.agencyId, s.dona, p.id, t1.id, { done: true });
  [row] = await listProjects(sql, s.agencyId, NOW);
  assert.equal(row.progress, 50, "com tarefas, o progresso manual é ignorado");
  await updateTask(sql, s.agencyId, s.dona, p.id, t1.id, { done: false, title: "Wireframe v2" });
  const t = (await listTasks(sql, s.agencyId, p.id))[0];
  assert.deepEqual([t.title, t.done, t.done_at], ["Wireframe v2", false, null]);
  await deleteTask(sql, s.agencyId, p.id, t2.id);
  await assert.rejects(deleteTask(sql, s.agencyId, p.id, t2.id), /Tarefa não encontrada/);

  // RLS: só a equipe da agência lê os projetos pelo banco.
  for (const [who, n] of [[s.bia, 1], [outra.dona, 0]] as const) {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [who]);
    await db.query(`set role authenticated`);
    try {
      assert.equal((await db.query(`select 1 from projects`)).rows.length, n);
      assert.equal((await db.query(`select 1 from project_tasks`)).rows.length, n);
    } finally {
      await db.query(`reset role`);
    }
  }

  await deleteProject(sql, s.agencyId, s.dona, p.id);
  assert.equal((await listProjects(sql, s.agencyId, NOW)).length, 0);
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from project_tasks where project_id = $1`, [p.id]))!.n, 0);
});
