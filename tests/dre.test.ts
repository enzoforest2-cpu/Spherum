import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { addEntry, dreReport, removeEntry, setTax } from "../src/lib/core/dre";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("DRE: receita das faturas pagas, impostos, despesas recorrentes, custo dos xodós e resultado", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência DRE" });
  const c = await createClient(sql, agencyId, dona, { name: "Cliente" });
  const rec = (await one<{ id: string }>(sql, `insert into invoice_recurrences (agency_id, client_id, description, amount_cents, day_of_month, next_due) values ($1, $2, 'Fee', 500000, 5, '2026-11-05') returning id`, [agencyId, c.id]))!.id;
  const inv = (desc: string, cents: number, paid: string, recurrence: string | null) => sql.query(
    `insert into invoices (agency_id, client_id, description, amount_cents, due_date, status, paid_at, paid_cents, recurrence_id) values ($1, $2, $3, $4, $5::date, 'pago', $5::timestamptz, $4, $6)`,
    [agencyId, c.id, desc, cents, paid, recurrence]);
  await inv("Fee set", 500000, "2026-09-10T15:00:00Z", rec);
  await inv("Fee out", 500000, "2026-10-10T15:00:00Z", null);
  await sql.query(`update invoices set recurrence_id = $2 where description = 'Fee out' and agency_id = $1`, [agencyId, rec]).catch(() => {});
  await inv("Landing page", 180000, "2026-10-12T15:00:00Z", null);
  await sql.query(`insert into ai_usage (agency_id, provider, model, cost_source, cost_brl, call_id, day) values ($1, 'anthropic', 'x', 'catalog', 123.45, $2, '2026-10-05')`, [agencyId, randomUUID()]);

  await setTax(sql, agencyId, 10);
  const folha = await addEntry(sql, agencyId, dona, { kind: "fixa", category: "Pessoal", description: "Folha", amount: 3000, month: "2026-09", recurring: true });
  await addEntry(sql, agencyId, dona, { kind: "variavel", category: "Terceiros", description: "Freela", amount: 500, month: "2026-10" });
  await addEntry(sql, agencyId, dona, { kind: "receita", category: "Bonificação", description: "Meta", amount: 200, month: "2026-10" });

  const now = new Date("2026-10-21T15:00:00Z");
  const first = await dreReport(sql, agencyId, 3, now);
  assert.equal(first.tax_pct, 10);
  let months = first.months;
  assert.deepEqual(months.map((m) => m.month), ["2026-08", "2026-09", "2026-10"]);
  const out = months[2];
  assert.deepEqual([out.fees, out.avulsos, out.outras, out.gross, out.tax], [5000, 1800, 200, 7000, 700]);
  assert.deepEqual([out.variable, out.fixed], [623.45, 3000]);
  assert.equal(Math.round(out.result * 100) / 100, 7000 - 700 - 623.45 - 3000);
  assert.ok(out.items.some((i) => i.auto && i.category === "Xodó"));
  assert.equal(months[1].fixed, 3000, "recorrente vale a partir do mês dela");
  assert.equal(months[0].fixed, 0);

  // Parar de repetir a partir de outubro: setembro mantém, outubro não.
  await removeEntry(sql, agencyId, folha.id, "2026-10");
  ({ months } = await dreReport(sql, agencyId, 3, now));
  assert.deepEqual([months[1].fixed, months[2].fixed], [3000, 0]);
  await removeEntry(sql, agencyId, folha.id);
  ({ months } = await dreReport(sql, agencyId, 3, now));
  assert.equal(months[1].fixed, 0);
});
