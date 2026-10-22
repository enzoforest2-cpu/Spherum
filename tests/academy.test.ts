import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { academyBoard, assignTrail, createItem, deleteItem, processToProject, remindOnboarding, toggleStep, updateItem } from "../src/lib/core/academy";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { listTasks } from "../src/lib/core/projects";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("academy: trilha com progresso por pessoa, processo vira projeto e onboarding com lembrete", async () => {
  const user = async (n: string) => (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`, [`${randomUUID()}@x.com`, n]))!.id;
  const ana = await user("Ana Souza"), beto = await user("Beto Lima");
  const { id: agencyId } = await createAgency(sql, ana, { name: "Agência Academy" });
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [agencyId, beto]);

  const t = await createItem(sql, agencyId, ana, { kind: "trilha", name: "Tráfego pago do zero", steps: [{ title: "Pixel", sub: "12 min" }, { title: "Estrutura de campanha", sub: "15 min", url: "https://youtu.be/x" }] });
  await assert.rejects(createItem(sql, agencyId, ana, { kind: "trilha", name: "tráfego pago do zero" }), /Já existe/);
  await assignTrail(sql, agencyId, ana, t.id, { user_id: beto, due_date: "2026-11-15" });
  let tr = (await academyBoard(sql, agencyId, beto)).find((x) => x.id === t.id)! as { steps: { id: string }[]; who: { name: string; pct: number }[]; mine: string[] };
  await toggleStep(sql, agencyId, beto, t.id, tr.steps[0].id, true);
  tr = (await academyBoard(sql, agencyId, beto)).find((x) => x.id === t.id)! as typeof tr;
  assert.deepEqual(tr.who.map((w) => [w.name, w.pct]), [["Beto Lima", 50]]);
  assert.deepEqual(tr.mine, [tr.steps[0].id]);
  assert.equal(((await academyBoard(sql, agencyId, ana)).find((x) => x.id === t.id) as { mine: string[] }).mine.length, 0, "o progresso é de cada um");
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from notifications where user_id = $1 and kind = 'trilha_atribuida'`, [beto]))!.n, 1);

  // Passo removido leva o progresso junto.
  await updateItem(sql, agencyId, t.id, { steps: [tr.steps[1]] });
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from academy_progress where item_id = $1`, [t.id]))!.n, 0);

  const c = await createClient(sql, agencyId, ana, { name: "Clínica Aurora" });
  const s = await createItem(sql, agencyId, ana, { kind: "processo", name: "Subir campanha no Meta", steps: [{ title: "Pixel testado", owner_user: beto }, { title: "Verba conferida" }] });
  await assert.rejects(toggleStep(sql, agencyId, ana, s.id, "xxxx", true), /Processo não tem progresso/);
  const r = await processToProject(sql, agencyId, ana, s.id, { client_id: c.id, due_date: "2026-11-10" }, new Date("2026-10-22T12:00:00Z"));
  assert.equal(r.tasks, 2);
  const tasks = await listTasks(sql, agencyId, r.project_id);
  assert.deepEqual(tasks.map((x) => [x.title, x.assignee_user]), [["Pixel testado", beto], ["Verba conferida", null]]);
  assert.equal((await one<{ name: string }>(sql, `select name from projects where id = $1`, [r.project_id]))!.name, "Subir campanha no Meta · Clínica Aurora");

  const o = await createItem(sql, agencyId, ana, { kind: "onboarding", name: "Onboarding Bianca", hire_name: "Bianca Moura", hire_role: "Designer", start_date: "2026-11-03" });
  const ob = (await academyBoard(sql, agencyId, ana)).find((x) => x.id === o.id)! as { steps: { id: string; group: string }[]; done: string[] };
  assert.equal(ob.steps.length, 7);
  assert.equal(ob.steps[0].group, "Antes do 1º dia");
  await toggleStep(sql, agencyId, beto, o.id, ob.steps[0].id, true);
  assert.equal(((await academyBoard(sql, agencyId, ana)).find((x) => x.id === o.id) as { done: string[] }).done.length, 1, "o progresso é um só");
  assert.deepEqual(await remindOnboarding(sql, agencyId, o.id), { pending: 6, people: 1 });
  await deleteItem(sql, agencyId, o.id);
  assert.equal((await academyBoard(sql, agencyId, ana)).length, 2);
});
