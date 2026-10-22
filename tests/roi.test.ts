import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { addSale, deleteSale, importSales, publishRoi, roiReport } from "../src/lib/core/roi";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb, seedMetrics } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("retorno: investimento contra vendas, por campanha, histórico e publicação no portal", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência ROI" });
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Aurora" });
  await seedMetrics(sql, agencyId, c.id, [
    { day: "2026-09-05", campaign_id: "h1", campaign_name: "Harmonização · Leads", spend_cents: 260000, leads: 58, clicks: 900, conversions: 20 },
    { day: "2026-09-06", campaign_id: "b1", campaign_name: "Botox · Remarketing", spend_cents: 120000, leads: 24, clicks: 400, conversions: 6 },
    { day: "2026-08-10", campaign_id: "h1", campaign_name: "Harmonização · Leads", spend_cents: 200000, leads: 40 },
  ]);

  await assert.rejects(addSale(sql, agencyId, c.id, dona, "manual", { sold_on: "2026-09-21", amount: 100, campaign_id: "zzz" }), /Campanha não encontrada/);
  await assert.rejects(addSale(sql, agencyId, c.id, dona, "manual", { sold_on: "2026-09-01", amount: 100, lead_on: "2026-09-10" }), /depois da venda/);
  await addSale(sql, agencyId, c.id, dona, "manual", { sold_on: "2026-09-21", amount: 1800, customer: "Juliana Martins", campaign_id: "h1", lead_on: "2026-09-09" });
  await addSale(sql, agencyId, c.id, dona, "portal", { sold_on: "2026-09-10", amount: 1200, customer: "Renata", campaign_id: "b1", lead_on: "2026-09-02" });
  const imp = await importSales(sql, agencyId, c.id, dona, [
    { sold_on: "2026-09-18", amount: 2400, external_id: "p1" }, { sold_on: "2026-09-18", amount: 2400, external_id: "p1" }, { amount: 5 }, { sold_on: "2026-08-20", amount: 3000 },
  ]);
  assert.deepEqual([imp.added, imp.duplicate, imp.failed], [2, 1, 1]);

  const r = await roiReport(sql, agencyId, c.id, "2026-09");
  assert.deepEqual([r.spend_cents, r.sales, r.revenue_cents, r.month_label, r.source], [380000, 3, 540000, "setembro", "manual"]);
  assert.equal(r.roi!.toFixed(2), "1.42");
  assert.deepEqual([r.top.label, r.top.value, r.match_pct, r.cycle_days], ["Leads", 82, 67, 10]);
  assert.deepEqual(r.campaigns.map((x) => [x.name, x.sales, x.revenue_cents]), [["Harmonização · Leads", 1, 180000], ["Botox · Remarketing", 1, 120000]]);
  assert.deepEqual(r.history.slice(-2), [{ month: "2026-08", spend_cents: 200000, revenue_cents: 300000 }, { month: "2026-09", spend_cents: 380000, revenue_cents: 540000 }]);
  // Padrão: o mês passado.
  assert.equal((await roiReport(sql, agencyId, c.id, undefined, new Date("2026-10-22T12:00:00Z"))).month, "2026-09");

  await publishRoi(sql, agencyId, dona, c.id, "2026-09");
  const u = await one<{ title: string; why: string; status: string }>(sql, `select title, why, status from client_updates where client_id = $1`, [c.id]);
  assert.equal(u!.title, "Retorno de setembro: cada R$ 1 em anúncio virou R$ 1,42 em vendas");
  assert.equal(u!.status, "publicado");
  await assert.rejects(publishRoi(sql, agencyId, dona, c.id, "2025-01"), /Sem investimento/);

  await deleteSale(sql, agencyId, r.recent[0].id);
  assert.equal((await roiReport(sql, agencyId, c.id, "2026-09")).sales, 2);
});
