import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { automationBoard, automationSweep, createAutomation, fill, setEnabled, testAutomation, type AutoDeps } from "../src/lib/core/automations";
import { createClient } from "../src/lib/core/clients";
import type { EmailMessage } from "../src/lib/core/email";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("automações: lembrete de reunião espera, confere e envia; condição falsa para; fatura dispara uma vez", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Auto" });
  const mails: EmailMessage[] = [], zaps: { to: string; params: string[] }[] = [];
  const deps: AutoDeps = { sql, mailer: async (m) => { mails.push(m); return true; }, whatsapp: async (_a, _c, to, m) => { zaps.push({ to, params: m.params }); } };

  const a = await createAutomation(sql, agencyId, dona, { name: "Lembrete de reunião", trigger: { type: "reuniao" }, steps: [
    { kind: "espera", type: "antes_do_evento", minutes: 1440 },
    { kind: "condicao", type: "reuniao_confirmada" },
    { kind: "acao", type: "email", subject: "Amanhã: {reuniao}", text: "Oi {nome}, nossa conversa é {data} às {hora}. Link: {link}" },
  ] });
  await assert.rejects(createAutomation(sql, agencyId, dona, { name: "X", trigger: { type: "relatorio_publicado" }, steps: [{ kind: "espera", type: "antes_do_evento", minutes: 10 }] }), /só vale para reunião/);
  const t0 = new Date("2026-10-22T12:00:00Z");
  await setEnabled(sql, agencyId, a.id, true, t0);

  // Reunião marcada depois de ligar, para sexta 23/10 às 15h (Brasília).
  const bt = (await one<{ id: string }>(sql, `insert into booking_types (agency_id, code, name) values ($1, 'abcdefgh99', 'Diagnóstico') returning id`, [agencyId]))!.id;
  await sql.query(`insert into bookings (agency_id, type_id, name, email, start_at, end_at, cancel_hash, meet_link, created_at) values ($1, $2, 'Rafael Couto', 'rafa@x.com', '2026-10-23T18:00:00Z', '2026-10-23T18:30:00Z', 'h1', 'https://meet.google.com/x', '2026-10-22T12:05:00Z')`, [agencyId, bt]);

  const s1 = await automationSweep(deps, new Date("2026-10-22T12:10:00Z"));
  assert.deepEqual(s1, { started: 1, advanced: 1 });
  let run = (await automationBoard(sql, agencyId)).runs[0];
  assert.equal(run.status, "esperando");
  assert.equal(run.resume_at!.slice(0, 16), "2026-10-22 18:00");
  assert.equal(mails.length, 0);
  assert.deepEqual(await automationSweep(deps, new Date("2026-10-22T12:20:00Z")), { started: 0, advanced: 0 }, "não dispara de novo nem antes da hora");

  await automationSweep(deps, new Date("2026-10-22T18:01:00Z"));
  run = (await automationBoard(sql, agencyId)).runs[0];
  assert.equal(run.status, "feito");
  assert.equal(mails[0].subject, "Amanhã: Diagnóstico");
  assert.equal(mails[0].text, "Oi Rafael, nossa conversa é 23/10 às 15:00. Link: https://meet.google.com/x");

  // Formulário com valor baixo: a condição para a execução.
  const f = await createAutomation(sql, agencyId, dona, { name: "Lead quente", trigger: { type: "formulario" }, steps: [
    { kind: "condicao", type: "valor_minimo", value: 5000 }, { kind: "acao", type: "whatsapp", template: "boas_vindas", text: "Oi {nome}, aqui é da agência" },
  ] });
  await setEnabled(sql, agencyId, f.id, true, t0);
  await sql.query(`insert into integration_connections (agency_id, provider, label, status, ciphertext) values ($1, 'whatsapp_cloud', 'WA', 'active', 'v1:x')`, [agencyId]);
  const form = (await one<{ id: string }>(sql, `insert into forms (agency_id, code, name) values ($1, 'formcode01', 'Diagnóstico') returning id`, [agencyId]))!.id;
  const deal1 = (await one<{ id: string }>(sql, `insert into deals (agency_id, company, contact_name, phone, value_cents) values ($1, 'Loja A', 'Bia Rocha', '(41) 99999-0001', 100000) returning id`, [agencyId]))!.id;
  const deal2 = (await one<{ id: string }>(sql, `insert into deals (agency_id, company, contact_name, phone, value_cents) values ($1, 'Loja B', 'Caio Reis', '(41) 99999-0002', 900000) returning id`, [agencyId]))!.id;
  await sql.query(`insert into form_submissions (form_id, agency_id, answers, deal_id, created_at) values ($1, $2, '{}', $3, '2026-10-22T13:00:00Z'), ($1, $2, '{}', $4, '2026-10-22T13:01:00Z')`, [form, agencyId, deal1, deal2]);
  await automationSweep(deps, new Date("2026-10-22T13:05:00Z"));
  const runs = (await automationBoard(sql, agencyId)).runs.filter((r) => r.automation_id === f.id);
  assert.deepEqual(runs.map((r) => r.status).sort(), ["feito", "parado"]);
  assert.deepEqual(zaps, [{ to: "5541999990002", params: ["Caio"] }]);

  // Fatura vence em 3 dias: dispara uma vez só.
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Aurora" });
  await sql.query(`insert into client_contacts (agency_id, client_id, name, email, is_primary) values ($1, $2, 'Carolina', 'carol@x.com', true)`, [agencyId, c.id]);
  await sql.query(`insert into invoices (agency_id, client_id, description, amount_cents, due_date) values ($1, $2, 'Mensalidade', 250000, '2026-10-26')`, [agencyId, c.id]);
  const inv = await createAutomation(sql, agencyId, dona, { name: "Cobrança gentil", trigger: { type: "fatura_vence", days: 3 }, steps: [{ kind: "acao", type: "email", subject: "Fatura de {valor}", text: "Oi {nome}, vence {data}." }] });
  await setEnabled(sql, agencyId, inv.id, true, t0);
  assert.equal((await automationSweep(deps, new Date("2026-10-22T14:00:00Z"))).started, 0, "faltam 4 dias");
  assert.equal((await automationSweep(deps, new Date("2026-10-23T14:00:00Z"))).started, 1);
  assert.equal((await automationSweep(deps, new Date("2026-10-23T15:00:00Z"))).started, 0);
  assert.equal(mails.at(-1)!.subject, "Fatura de R$ 2.500");
  assert.equal(mails.at(-1)!.text, "Oi Carolina, vence 26/10.");

  // Testar não envia nada.
  const before = mails.length;
  const t = await testAutomation(deps, agencyId, a.id, new Date("2026-10-22T19:00:00Z"));
  assert.equal(t.example, "último evento real");
  assert.match(t.lines.at(-1)!.text, /E-mail para rafa@x.com/);
  assert.equal(mails.length, before);
  assert.equal(fill("{valor} {nada}", { kind: "formulario", value_cents: 123456 }), "R$ 1.235 {nada}");
});
