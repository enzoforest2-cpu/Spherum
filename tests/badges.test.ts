import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { badgeBoard, giveKudos, setConfig } from "../src/lib/core/badges";
import { createProject, addTask, updateTask } from "../src/lib/core/projects";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("conquistas: pontos por tarefa no prazo e reconhecimento, ranking escondido e emblema", async () => {
  const user = async (n: string) => (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`, [`${randomUUID()}@x.com`, n]))!.id;
  const ana = await user("Ana Souza"), beto = await user("Beto Lima");
  const { id: agencyId } = await createAgency(sql, ana, { name: "Agência Conquistas" });
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [agencyId, beto]);
  const now = new Date();
  const due = new Date(now.getTime() + 5 * 864e5).toISOString().slice(0, 10);
  const p = await createProject(sql, agencyId, ana, { name: "P", due_date: due });
  for (let i = 0; i < 3; i++) {
    const t = await addTask(sql, agencyId, p.id, { title: "T" + i, assignee_user: beto, due_date: due });
    await updateTask(sql, agencyId, ana, p.id, t.id, { done: true });
  }
  await assert.rejects(giveKudos(sql, agencyId, ana, { to_user: ana, text: "eu mesmo" }), /colega/);
  await giveKudos(sql, agencyId, ana, { to_user: beto, text: "Salvou a reunião" });
  await assert.rejects(giveKudos(sql, agencyId, ana, { to_user: beto, text: "de novo" }), /hoje/);

  let b = await badgeBoard(sql, agencyId, ana, "month", now);
  assert.deepEqual(b.ranking.map((r) => [r.name, r.points]), [["Beto Lima", 3 * 10 + 20], ["Ana Souza", 0]]);
  assert.match(b.feed[0].text, /reconhecimento de Ana: “Salvou a reunião”/);
  assert.ok(b.challenge && b.challenge.days_ok === b.challenge.days_so_far, "sem chamado atrasado");

  await setConfig(sql, agencyId, { points: { task: 50 }, show_ranking: false, challenge: { title: "Todo relatório no dia 1º", prize: "pizza" } });
  b = await badgeBoard(sql, agencyId, beto, "month", now);
  assert.deepEqual(b.ranking.map((r) => [r.name, r.points]), [["Beto Lima", 170]], "com o ranking escondido, cada um vê só os seus");
  assert.equal(b.challenge!.prize, "pizza");
  assert.equal((await badgeBoard(sql, agencyId, ana, "month", now)).ranking.length, 2, "a dona vê todos");
  assert.deepEqual(b.badges.find((x) => x.name === "Um ano de casa")!.who, []);
});
