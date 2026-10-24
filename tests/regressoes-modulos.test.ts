import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency, updateAgency, validTimezone } from "../src/lib/core/agencies";
import { listContracts } from "../src/lib/core/contracts";
import { createDeal, winDeal } from "../src/lib/core/crm";
import { dreReport } from "../src/lib/core/dre";
import { createForm, submitForm } from "../src/lib/core/forms";
import { acceptProposal, addMonths, createProposal, sendProposal } from "../src/lib/core/proposals";
import { answerNps, requestNps } from "../src/lib/core/risk";
import { openTicket, setSla } from "../src/lib/core/tickets";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb, seedClient } from "./helpers";

/**
 * Regressões achadas na revisão de 24/10: cada teste reproduz o cenário que quebrava e confere o comportamento corrigido.
 */

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function user(email: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, '{}'::jsonb) returning id`, [email]))!.id;
}

test("SLA com meia hora reajusta os chamados abertos sem erro de tipo", async () => {
  const dona = await user(`a-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "A" });
  const c = await seedClient(sql, agencyId, "C");
  const t = await openTicket(sql, agencyId, dona, "agencia", { client_id: c, subject: "Anúncio parado", priority: "alta" });
  await setSla(sql, agencyId, { alta: 0.5, media: 4, baixa: 48 });
  const row = await one<{ mins: number }>(sql, `select round(extract(epoch from (due_at - created_at)) / 60)::int as mins from tickets where id = $1`, [t.id]);
  assert.equal(row!.mins, 30);
});

test("fuso horário inválido é recusado; o válido continua funcionando", async () => {
  const dona = await user(`f-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "F" });
  await assert.rejects(updateAgency(sql, agencyId, dona, { timezone: "Brasilia" }), /Fuso horário desconhecido/);
  await updateAgency(sql, agencyId, dona, { timezone: "America/Manaus" });
  await listContracts(sql, agencyId);
  assert.equal(validTimezone("Europe/Lisbon"), true);
  assert.equal(validTimezone("Marte/Olympus"), false);
});

test("proposta aceita depois de o negócio já ter sido fechado usa o cliente do negócio", async () => {
  const dona = await user(`b-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "B" });
  const now = new Date("2026-10-21T15:00:00Z");
  const deal = await createDeal(sql, agencyId, dona, { company: "Dup Co", value: 2000, stage: "diagnostico" });
  const p = await createProposal(sql, agencyId, dona, { company: "Dup Co", deal_id: deal.id, monthly_cents: 200000, term_months: 6 });
  const s = await sendProposal(sql, agencyId, dona, p.id, 15, now);
  const won = await winDeal(sql, agencyId, dona, deal.id, { contract: true, onboarding: false }, now);
  const r = await acceptProposal(sql, s.token, { name: "Fulano Silva", email: "f@x.com", agree: true }, null, now);
  assert.equal(r.client_id, won.client_id);
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from clients where agency_id = $1 and name = 'Dup Co'`, [agencyId]))!.n, 1);
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from client_contracts where agency_id = $1`, [agencyId]))!.n, 1);
  await assert.rejects(acceptProposal(sql, s.token, { name: "Fulano Silva", email: "f@x.com", agree: true }, null, now), /já foi aceita/);
  await assert.rejects(winDeal(sql, agencyId, dona, deal.id, { contract: true }, now), /já virou cliente/);
});

test("validade da proposta segue o dia de Brasília; soma de meses não estoura o mês", async () => {
  const dona = await user(`g-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "G" });
  const p = await createProposal(sql, agencyId, dona, { company: "G Co", monthly_cents: 0 });
  const s = await sendProposal(sql, agencyId, dona, p.id, 15, new Date("2026-10-21T15:00:00Z"));
  assert.equal(s.valid_until, "2026-11-05");
  // 22h de Brasília do último dia válido ainda vale.
  await acceptProposal(sql, s.token, { name: "Fulano Silva", email: "f@x.com", agree: true }, null, new Date("2026-11-06T01:00:00Z"));
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-15", 2), "2027-01-15");
});

test("formulário público segue aceitando leads quando o dono saiu da equipe; e-mail com acento é recusado com mensagem por campo", async () => {
  const dona = await user(`c-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "C" });
  const m = await user(`cm-${randomUUID()}@x.com`);
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [agencyId, m]);
  const f = await createForm(sql, agencyId, dona, { name: "F", owner_user: m, fields: [{ id: "nome", t: "text", l: "Seu nome", req: true }, { id: "mail", t: "email", l: "E-mail", req: true }] });
  await sql.query(`delete from agency_members where user_id = $1`, [m]);
  const r = await submitForm(sql, f.code, { nome: "João", mail: "joao@empresa.com" }, "1.1.1.1", "s");
  assert.ok(r);
  const deal = await one<{ owner_user: string }>(sql, `select owner_user from deals where agency_id = $1 order by created_at desc limit 1`, [agencyId]);
  assert.equal(deal!.owner_user, dona);
  await assert.rejects(submitForm(sql, f.code, { nome: "João", mail: "joão@empresa.com" }, "1.1.1.1", "s"), (e: { body?: { errors?: Record<string, string> }; message: string }) => /inválido|Confira/.test(e.message) || !!e.body?.errors?.mail);
});

test("DRE: pagamento às 23h de Brasília do último dia fica no mês certo", async () => {
  const dona = await user(`d-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "D" });
  const c = await seedClient(sql, agencyId, "C");
  await sql.query(`insert into invoices (agency_id, client_id, description, amount_cents, due_date, status, paid_at, paid_cents) values ($1, $2, 'x', 100000, '2026-10-31', 'pago', '2026-11-01T02:00:00Z', 100000)`, [agencyId, c]);
  const r = await dreReport(sql, agencyId, 3, new Date("2026-11-01T02:30:00Z"));
  assert.equal(r.months.find((m) => m.month === "2026-10")?.avulsos, 1000);
});

test("NPS: só com pergunta aberta, e cada pergunta é respondida uma vez", async () => {
  const dona = await user(`e-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona, { name: "E" });
  const c = await seedClient(sql, agencyId, "C");
  const u = await user(`eu-${randomUUID()}@x.com`);
  await assert.rejects(answerNps(sql, agencyId, c, u, { score: 9 }), /já foi respondida/);
  await requestNps(sql, agencyId, dona, { client_ids: [c], question: "De 0 a 10, quanto você indicaria a agência?" });
  await answerNps(sql, agencyId, c, u, { score: 9 });
  await assert.rejects(answerNps(sql, agencyId, c, u, { score: 2 }), /já foi respondida/);
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from nps_responses where client_id = $1`, [c]))!.n, 1);
});
