import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { listContracts } from "../src/lib/core/contracts";
import { createDeal, crmBoard, deleteDeal, updateDeal, winDeal } from "../src/lib/core/crm";
import { agencyPortal } from "../src/lib/core/portal";
import { listProjects, listTasks } from "../src/lib/core/projects";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function user(email: string, name?: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(name ? { full_name: name } : {})]))!.id;
}

test("funil: criar, mover, perder; ganho vira cliente com contato, onboarding e contrato; números de 90 dias", async () => {
  const dona = await user(`dona-${randomUUID()}@x.com`, "Ana Souza");
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência CRM" });
  const now = new Date("2026-10-21T15:00:00Z");

  const a = await createDeal(sql, agencyId, dona, { company: "Padaria Trigo", contact_name: "Rita", email: "RITA@trigo.com", phone: "11 9999", value: 2500, stage: "proposta", next_action: "Ligar" });
  const b = await createDeal(sql, agencyId, dona, { company: "Ótica Visão", value: 1800 });
  const c = await createDeal(sql, agencyId, dona, { company: "Pet Feliz", value: 900, stage: "contato" });
  await assert.rejects(createDeal(sql, agencyId, dona, { company: "X", owner_user: randomUUID() }), /não é da equipe/);
  await assert.rejects(updateDeal(sql, agencyId, dona, b.id, { stage: "ganho" }), /Marcar como fechado/);
  await updateDeal(sql, agencyId, dona, b.id, { stage: "negociacao", contacted: true, next_action: "Mandar contrato", next_action_date: "2026-10-25" });
  await updateDeal(sql, agencyId, dona, c.id, { stage: "perdido", lost_reason: "Sem verba" });

  let board = await crmBoard(sql, agencyId, now);
  const byCo = Object.fromEntries(board.deals.map((d) => [d.company, d]));
  assert.deepEqual([byCo["Padaria Trigo"].owner_name, byCo["Padaria Trigo"].email, byCo["Ótica Visão"].stage, !!byCo["Ótica Visão"].last_contact_at, byCo["Pet Feliz"].lost_reason], ["Ana Souza", "rita@trigo.com", "negociacao", true, "Sem verba"]);
  // Previsão = proposta (50%) + negociação (70%).
  assert.deepEqual([board.stats.pipeline_cents, board.stats.forecast_cents, board.stats.open, board.stats.close_rate], [430000, 125000 + 126000, 2, 0]);

  const won = await winDeal(sql, agencyId, dona, a.id, { billing_day: 5 }, now);
  await assert.rejects(winDeal(sql, agencyId, dona, a.id, {}, now), /já virou cliente/);
  await assert.rejects(updateDeal(sql, agencyId, dona, a.id, { stage: "contato" }), /não volta para o funil/);
  const client = await one<{ name: string; status: string; monthly_fee_cents: number; contact: string }>(sql,
    `select c.name, c.status, c.monthly_fee_cents::float8 as monthly_fee_cents, ct.name as contact from clients c join client_contacts ct on ct.client_id = c.id where c.id = $1`, [won.client_id]);
  assert.deepEqual(client, { name: "Padaria Trigo", status: "onboarding", monthly_fee_cents: 250000, contact: "Rita" });
  const [proj] = await listProjects(sql, agencyId, now);
  assert.deepEqual([proj.name, proj.client_id, proj.due_date, (await listTasks(sql, agencyId, proj.id)).length], ["Onboarding · Padaria Trigo", won.client_id, "2026-10-30", 14]);
  const [k] = await listContracts(sql, agencyId, now);
  assert.deepEqual([k.client_id, k.monthly_fee_cents, k.end_date, k.recurrence_day, k.recurrence_next], [won.client_id, 250000, "2027-10-21", 5, "2026-11-05"]);
  assert.equal(won.email, "rita@trigo.com");

  board = await crmBoard(sql, agencyId, now);
  assert.deepEqual([board.stats.won_90d, board.stats.lost_90d, board.stats.close_rate, board.stats.open], [1, 1, 50, 1]);
  assert.equal((await agencyPortal(sql, agencyId, dona, now)).crm.deals.length, 3);

  // Sem contrato nem onboarding, e sem valor: só o cliente.
  const d = await createDeal(sql, agencyId, dona, { company: "Free" });
  const w2 = await winDeal(sql, agencyId, dona, d.id, { contract: true, onboarding: false }, now);
  assert.deepEqual([w2.contract_id, w2.project_id], [null, null]);
  await deleteDeal(sql, agencyId, dona, b.id);
  await assert.rejects(deleteDeal(sql, agencyId, dona, b.id), /não encontrado/);
});
