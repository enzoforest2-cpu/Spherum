import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import type { EmailMessage } from "../src/lib/core/email";
import { cancelNote, emitForInvoice, fiscalBoard, fiscalSweep, setClientTax, setConfig, type FiscalDeps, type NoteRequest, type NoteStatus } from "../src/lib/core/fiscal";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("notas: emite pela regra do pagamento, consulta, envia PDF e XML; régua de cobrança uma vez por tipo", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Fiscal" });
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Aurora" });
  await sql.query(`insert into client_contacts (agency_id, client_id, name, email, is_primary) values ($1, $2, 'Carol', 'carol@x.com', true)`, [agencyId, c.id]);
  const conn = (await one<{ id: string }>(sql, `insert into integration_connections (agency_id, provider, label, status, ciphertext) values ($1, 'focusnfe', 'Focus', 'active', 'v1:x') returning id`, [agencyId]))!.id;

  const sent: NoteRequest[] = [];
  let next: NoteStatus = { status: "processando" };
  const mails: EmailMessage[] = [];
  const deps: FiscalDeps = { sql, mailer: async (m) => { mails.push(m); return true; },
    provider: { emit: async (_a, _c, _e, req) => { sent.push(req); return { status: "processando" }; }, query: async () => next, cancel: async () => ({ status: "cancelada" }) } };

  const inv = (await one<{ id: string }>(sql, `insert into invoices (agency_id, client_id, description, amount_cents, due_date) values ($1, $2, 'Mensalidade', 250000, '2026-10-10') returning id`, [agencyId, c.id]))!.id;
  await assert.rejects(emitForInvoice(deps, agencyId, inv, dona), /Complete as configurações fiscais/);
  await setConfig(sql, agencyId, { connection_id: conn, cnpj: "12.345.678/0001-90", inscricao_municipal: "123", codigo_municipio: "4106902", aliquota: 2, accountant_email: "xml@contabil.com", emit_when: "pay" }, new Date("2026-10-01T12:00:00Z"));
  await assert.rejects(emitForInvoice(deps, agencyId, inv, dona), /CPF ou CNPJ de Clínica Aurora/);
  await setClientTax(sql, agencyId, c.id, { cnpj: "98.765.432/0001-10", legal_name: "Clínica Aurora Ltda" });

  // Pagou: o cron emite sozinho.
  await sql.query(`update invoices set status = 'pago', paid_at = '2026-10-09T15:00:00Z', paid_cents = 250000 where id = $1`, [inv]);
  let s = await fiscalSweep(deps, new Date("2026-10-09T16:00:00Z"));
  assert.equal(s.emitted, 1);
  assert.deepEqual([sent[0].tomador, sent[0].servico.valor, sent[0].prestador.cnpj, sent[0].servico.discriminacao], [{ doc: "98765432000110", name: "Clínica Aurora Ltda", email: "carol@x.com" }, 2500, "12345678000190", "Gestão de marketing digital · out/26"]);
  await assert.rejects(emitForInvoice(deps, agencyId, inv, dona), /já tem nota/);

  // A prefeitura autoriza: PDF para o cliente, XML para a contabilidade (uma vez).
  next = { status: "emitida", number: "489", verification_code: "ABC", pdf_url: "https://nf/pdf", xml_url: "https://nf/xml" };
  s = await fiscalSweep(deps, new Date("2026-10-09T16:15:00Z"));
  assert.equal(s.updated, 1);
  const b = await fiscalBoard(sql, agencyId, new Date("2026-10-09T16:20:00Z"));
  assert.deepEqual([b.notes[0].number, b.notes[0].status, b.pending.length], ["489", "emitida", 0]);
  assert.deepEqual(mails.map((m) => m.to), ["carol@x.com", "xml@contabil.com"]);
  await fiscalSweep(deps, new Date("2026-10-09T16:30:00Z"));
  assert.equal(mails.length, 2, "não reenvia");

  await assert.rejects(cancelNote(deps, agencyId, b.notes[0].id, "curto"), /15 caracteres/);
  await cancelNote(deps, agencyId, b.notes[0].id, "Valor lançado errado na fatura");
  assert.equal((await fiscalBoard(sql, agencyId)).notes[0].status, "cancelada");

  // Régua: 3 dias antes, no dia e 3 dias depois, sem repetir.
  await sql.query(`insert into invoices (agency_id, client_id, description, amount_cents, due_date, payment_url) values ($1, $2, 'Mensalidade nov', 250000, '2026-11-10', 'https://pay/x')`, [agencyId, c.id]);
  const before = mails.length;
  await fiscalSweep(deps, new Date("2026-11-07T12:00:00Z"));
  await fiscalSweep(deps, new Date("2026-11-07T13:00:00Z"));
  await fiscalSweep(deps, new Date("2026-11-10T12:00:00Z"));
  await fiscalSweep(deps, new Date("2026-11-13T12:00:00Z"));
  const dun = mails.slice(before).map((m) => m.subject);
  assert.deepEqual(dun, ["Mensalidade nov: R$ 2.500,00 vence em 3 dias (10/11/2026)", "Mensalidade nov: R$ 2.500,00 vence hoje", "Mensalidade nov: R$ 2.500,00 venceu em 10/11/2026"]);
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from notifications where agency_id = $1 and kind = 'fatura_atrasada'`, [agencyId]))!.n, 1);
});
