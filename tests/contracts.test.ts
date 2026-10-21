import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { billingSweep, listClientInvoices, type BillingDeps } from "../src/lib/billing";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import {
  cancelNotice, createContract, endContract, firstBillingDate, listContracts, noticeContract, pauseContract, pausedContract, renewContract, resumeContract, updateContract,
} from "../src/lib/core/contracts";
import { agencyPortal } from "../src/lib/core/portal";
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

async function setup(name = "Clínica Sorriso") {
  const dona = await user(`dona-${randomUUID()}@x.com`, "Ana Souza");
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Contratos" });
  const c = await createClient(sql, agencyId, dona, { name });
  return { dona, agencyId, clientId: c.id };
}

const rec = (id: string) => one<{ amount_cents: number; next_due: string; day_of_month: number; active: boolean }>(
  sql, `select amount_cents::float8 as amount_cents, next_due::text, day_of_month, active from invoice_recurrences where id = $1`, [id]);

test("primeira cobrança no dia escolhido", () => {
  assert.equal(firstBillingDate("2026-10-21", 10), "2026-11-10");
  assert.equal(firstBillingDate("2026-10-05", 10), "2026-10-10");
  assert.equal(firstBillingDate("2026-12-20", 5), "2027-01-05");
});

test("contrato cria a mensalidade; renovação reajusta; pausa suspende, cobra metade ou mantém; aviso prévio encerra", async () => {
  const s = await setup();
  let now = new Date("2026-10-21T15:00:00Z");
  const deps: BillingDeps = { sql, masterKey: "x".repeat(40), fetch: (() => { throw new Error("sem rede"); }) as never, appUrl: "https://spherum.com.br", now: () => now };

  const k = await createContract(sql, s.agencyId, s.dona, { client_id: s.clientId, monthly_fee: 4800, start_date: "2026-10-01", end_date: "2026-12-01", billing_day: 10 }, now);
  assert.deepEqual(await rec(k.recurrence_id!), { amount_cents: 480000, next_due: "2026-11-10", day_of_month: 10, active: true });
  await assert.rejects(createContract(sql, s.agencyId, s.dona, { client_id: s.clientId, monthly_fee: 100, start_date: "2026-10-01", end_date: "2027-10-01" }, now), /já tem um contrato em vigor/);
  let [row] = await listContracts(sql, s.agencyId, now);
  assert.deepEqual([row.state, row.days_to_end, row.client_name, row.fee_now_cents], ["renova", 41, "Clínica Sorriso", 480000]);

  // Renovar: nova data e reajuste de 5% também na mensalidade.
  await assert.rejects(renewContract(sql, s.agencyId, s.dona, k.id, { end_date: "2026-11-01", adjust_percent: 5 }), /vem depois da atual/);
  assert.deepEqual(await renewContract(sql, s.agencyId, s.dona, k.id, { end_date: "2027-12-01", adjust_percent: 5 }), { monthly_fee_cents: 504000 });
  assert.equal((await rec(k.recurrence_id!))!.amount_cents, 504000);
  [row] = await listContracts(sql, s.agencyId, now);
  assert.equal(row.state, "ativo");

  // Pausa de novembro com cobrança pela metade: a fatura de 10/11 sai com 50%.
  await assert.rejects(pauseContract(sql, s.agencyId, s.dona, k.id, { from: "2026-11-01", to: "2027-03-01", reason: "Férias", billing: "metade" }, now), /até 90 dias/);
  await pauseContract(sql, s.agencyId, s.dona, k.id, { from: "2026-11-01", to: "2026-12-01", reason: "Férias", billing: "metade" }, now);
  [row] = await listContracts(sql, s.agencyId, now);
  assert.deepEqual([row.state, row.pause_scheduled], ["ativo", true]);
  now = new Date("2026-11-02T12:00:00Z");
  [row] = await listContracts(sql, s.agencyId, now);
  assert.deepEqual([row.state, row.fee_now_cents], ["pausado", 252000]);
  assert.deepEqual(await pausedContract(sql, s.clientId, now), { until: "2026-12-01" });
  assert.equal((await billingSweep(deps)).generated, 1);
  let inv = await listClientInvoices(sql, s.clientId);
  assert.deepEqual(inv.map((i) => [i.due_date, i.amount_cents, i.description]), [["2026-11-10", 252000, "Mensalidade · Clínica Sorriso (pausa: 50%)"]]);

  // Pausa que suspende: dezembro não gera; volta automática quando a pausa termina.
  await resumeContract(sql, s.agencyId, s.dona, k.id);
  assert.equal(await pausedContract(sql, s.clientId, now), null);
  await pauseContract(sql, s.agencyId, s.dona, k.id, { from: "2026-12-01", to: "2026-12-31", reason: "Recesso", billing: "suspender" }, now);
  now = new Date("2026-12-02T12:00:00Z");
  assert.equal((await billingSweep(deps)).generated, 0);
  assert.equal((await rec(k.recurrence_id!))!.next_due, "2027-01-10", "dezembro foi pulado");
  now = new Date("2027-01-02T12:00:00Z");
  assert.equal((await billingSweep(deps)).generated, 1);
  [row] = await listContracts(sql, s.agencyId, now);
  assert.deepEqual([row.pause_from, row.state], [null, "ativo"], "a pausa que acabou some");

  // Aviso prévio: depois da saída não gera e o contrato encerra.
  await assert.rejects(noticeContract(sql, s.agencyId, s.dona, k.id, { notice_end: "2026-12-31" }, now), /no passado/);
  await noticeContract(sql, s.agencyId, s.dona, k.id, { notice_end: "2027-02-15", reason: "Corte de verba" }, now);
  await cancelNotice(sql, s.agencyId, s.dona, k.id);
  await noticeContract(sql, s.agencyId, s.dona, k.id, { notice_end: "2027-02-05" }, now);
  [row] = await listContracts(sql, s.agencyId, now);
  assert.deepEqual([row.state, row.notice_end], ["aviso", "2027-02-05"]);
  now = new Date("2027-02-03T12:00:00Z");
  assert.equal((await billingSweep(deps)).generated, 0, "fevereiro vence depois da saída");
  assert.equal((await rec(k.recurrence_id!))!.active, false);
  now = new Date("2027-02-06T12:00:00Z");
  await billingSweep(deps);
  [row] = await listContracts(sql, s.agencyId, now);
  assert.deepEqual([row.status, row.state, row.fee_now_cents], ["encerrado", "encerrado", 0]);
  await assert.rejects(renewContract(sql, s.agencyId, s.dona, k.id, { end_date: "2028-01-01" }), /já foi encerrado/);
  inv = await listClientInvoices(sql, s.clientId);
  assert.deepEqual(inv.map((i) => i.due_date), ["2027-01-10", "2026-11-10"]);

  // Com o anterior encerrado, dá para fazer um novo contrato, agora sem cobrança automática.
  const k2 = await createContract(sql, s.agencyId, s.dona, { client_id: s.clientId, monthly_fee: 0, start_date: "2027-03-01", end_date: "2027-09-01", billing: "nenhuma" }, now);
  assert.equal(k2.recurrence_id, null);
  const portal = await agencyPortal(sql, s.agencyId, s.dona, now);
  assert.equal(portal.contracts.length, 2);
});

test("usar a mensalidade existente, editar, encerrar e RLS", async () => {
  const s = await setup("Loja Verde");
  const outra = await setup("Outra");
  const now = new Date("2026-10-21T15:00:00Z");
  await assert.rejects(createContract(sql, s.agencyId, s.dona, { client_id: s.clientId, monthly_fee: 3000, start_date: "2026-10-01", end_date: "2027-10-01", billing: "existente" }, now), /não tem mensalidade automática/);
  await assert.rejects(createContract(sql, s.agencyId, s.dona, { client_id: outra.clientId, monthly_fee: 3000, start_date: "2026-10-01", end_date: "2027-10-01" }, now), /Cliente não encontrado/);
  await assert.rejects(createContract(sql, s.agencyId, s.dona, { client_id: s.clientId, monthly_fee: 3000, start_date: "2026-10-01", end_date: "2026-09-01" }, now), /fim da vigência/);
  const r = await one<{ id: string }>(sql,
    `insert into invoice_recurrences (agency_id, client_id, description, amount_cents, day_of_month, next_due) values ($1, $2, 'Fee', 250000, 5, '2026-11-05') returning id`,
    [s.agencyId, s.clientId]);
  const k = await createContract(sql, s.agencyId, s.dona, { client_id: s.clientId, monthly_fee: 3000, start_date: "2026-10-01", end_date: "2027-10-01", billing: "existente" }, now);
  assert.equal(k.recurrence_id, r!.id);
  assert.equal((await rec(r!.id))!.amount_cents, 300000, "o contrato manda no valor");
  await updateContract(sql, s.agencyId, s.dona, k.id, { monthly_fee: 3200, notes: "Inclui 8 criativos" });
  assert.equal((await rec(r!.id))!.amount_cents, 320000);
  await assert.rejects(updateContract(sql, outra.agencyId, outra.dona, k.id, { monthly_fee: 1 }), /Contrato não encontrado/);

  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [outra.dona]);
  await db.query(`set role authenticated`);
  try {
    assert.equal((await db.query(`select 1 from client_contracts where id = $1`, [k.id])).rows.length, 0);
  } finally {
    await db.query(`reset role`);
  }
  await endContract(sql, s.agencyId, s.dona, k.id);
  assert.equal((await rec(r!.id))!.active, false);
});
