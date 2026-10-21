import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { clientCollab } from "../src/lib/core/collab";
import { createMeeting, deleteMeeting, listMeetings, sendMinutes, stepsToTasks, toggleStep, writeMinutes } from "../src/lib/core/meetings";
import { listProjects, listTasks } from "../src/lib/core/projects";
import { one, type Sql } from "../src/lib/xodos/db";
import { TOOLS } from "../src/lib/xodos/tools";
import { createTestDb, seedXodo } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function user(email: string, name?: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(name ? { full_name: name } : {})]))!.id;
}

test("ata: registrar, xodó escreve, passos da equipe viram tarefas, enviar publica no portal", async () => {
  const dona = await user(`dona-${randomUUID()}@x.com`, "Ana Souza");
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Atas" });
  const marina = await user(`m-${randomUUID()}@x.com`, "Marina Alves");
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [agencyId, marina]);
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Aurora" });
  const now = new Date("2026-10-21T15:00:00Z");

  const m = await createMeeting(sql, agencyId, dona, { client_id: c.id, title: "Resultados de setembro", meeting_date: "2026-10-14", meeting_time: "10:00", attendees: ["Ana Souza", "Carolina"] });
  await assert.rejects(sendMinutes(sql, agencyId, dona, m.id), /Escreva a ata/);

  // O xodó escreve pela ferramenta registrar_ata.
  const xodo = await seedXodo(sql, agencyId, { name: "Faísca" });
  const tool = TOOLS.find((t) => t.name === "registrar_ata")!;
  const out = await tool.execute({ sql, xodo, runId: randomUUID(), now, apps: null } as never, tool.input.parse({
    reuniao_id: m.id, resumo: "CPL abaixo da meta.", decisoes: ["Verba sobe para R$ 6.000"],
    passos: [{ titulo: "Briefing da campanha de laser", responsavel: "marina", prazo: "2026-10-18" }, { titulo: "Fotos da sala nova", responsavel: "Carolina Reis" }],
  }));
  assert.deepEqual(out, { ata: "rascunho", cliente: "Clínica Aurora", passos: 2 });
  let [row] = await listMeetings(sql, agencyId);
  assert.deepEqual([row.status, row.xodo_name, row.decisions, row.steps.map((s) => [s.title, s.owner, !!s.owner_user])],
    ["rascunho", "Faísca", ["Verba sobe para R$ 6.000"], [["Briefing da campanha de laser", "Marina Alves", true], ["Fotos da sala nova", "Carolina Reis", false]]]);

  // Só o passo da equipe vira tarefa; marcar o passo marca a tarefa.
  assert.deepEqual((await stepsToTasks(sql, agencyId, dona, m.id, now)).created, 1);
  assert.equal((await stepsToTasks(sql, agencyId, dona, m.id, now)).created, 0, "não duplica");
  const [proj] = await listProjects(sql, agencyId, now);
  assert.equal(proj.name, "Combinados · Clínica Aurora");
  const [task] = await listTasks(sql, agencyId, proj.id);
  assert.deepEqual([task.title, task.assignee_name, task.due_date], ["Briefing da campanha de laser (reunião: Resultados de setembro)", "Marina Alves", "2026-10-18"]);
  [row] = await listMeetings(sql, agencyId);
  await toggleStep(sql, agencyId, m.id, row.steps[0].id, true);
  assert.equal((await listTasks(sql, agencyId, proj.id))[0].done, true);

  // Reescrever a ata mantém o passo que virou tarefa.
  await writeMinutes(sql, agencyId, { userId: dona }, m.id, { summary: "CPL de R$ 38, abaixo da meta.", decisions: [], steps: [{ title: "Aditivo de verba", owner: "Ana" }] });
  [row] = await listMeetings(sql, agencyId);
  assert.deepEqual(row.steps.map((s) => s.title), ["Briefing da campanha de laser", "Aditivo de verba"]);

  await sendMinutes(sql, agencyId, dona, m.id);
  await sendMinutes(sql, agencyId, dona, m.id);
  const portal = await clientCollab(sql, c.id, "cliente");
  assert.deepEqual(portal.updates.map((u) => u.title), ["Ata: Resultados de setembro"], "reenviar não duplica no portal");
  [row] = await listMeetings(sql, agencyId);
  assert.equal(row.status, "enviada");
  await deleteMeeting(sql, agencyId, dona, m.id);
  assert.equal((await listMeetings(sql, agencyId)).length, 0);
});
