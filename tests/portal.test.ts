import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { agencyPortal, goalGap, goalValue, initials, relative } from "../src/lib/core/portal";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const NOW = new Date("2026-10-19T12:00:00Z");

async function user(email: string, meta: Record<string, unknown> = {}) {
  const row = await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(meta)]);
  return row!.id;
}

async function metric(agencyId: string, clientId: string, day: string, campaign: string, spend: number, leads: number, revenue = 0, platform = "meta") {
  await sql.query(
    `insert into metrics_daily (agency_id, client_id, platform, account_id, campaign_id, campaign_name, day, spend_cents, leads, revenue_cents)
     values ($1, $2, $3, 'act_1', $4, $5, $6::date, $7, $8, $9)`,
    [agencyId, clientId, platform, campaign, `Campanha ${campaign}`, day, spend * 100, leads, revenue * 100],
  );
}

test("utilitários: iniciais, tempo relativo e meta", () => {
  assert.equal(initials("Clínica Sorriso Bom"), "CS");
  assert.equal(initials("Lu"), "L");
  assert.equal(relative(new Date("2026-10-19T11:20:00Z"), NOW), "há 40 min");
  assert.equal(relative(new Date("2026-10-18T10:00:00Z"), NOW), "ontem");
  assert.equal(relative(null, NOW), "—");
  assert.equal(goalValue("CPL", { spend: 100, results: 4, revenue: 0 }), 25);
  assert.equal(goalValue("ROAS", { spend: 100, results: 4, revenue: 350 }), 3.5);
  assert.equal(goalValue("CPL", { spend: 100, results: 0, revenue: 0 }), null);
  assert.equal(goalGap("CPL", 20, 25), 25);
  assert.equal(goalGap("ROAS", 4, 3), 25);
  assert.equal(goalGap(null, 20, 25), null);
});

test("portal da agência: clientes com meta, campanhas, plataformas, série diária, equipe e avisos", async () => {
  const dona = await user(`dona-${randomUUID()}@exemplo.com`, { full_name: "Ana Souza" });
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Portal" });

  const empty = await agencyPortal(sql, agencyId, dona, NOW);
  assert.deepEqual([empty.clients.length, empty.camps.length, empty.plat.length, empty.daily.length], [0, 0, 0, 0]);
  assert.equal(empty.me.name, "Ana Souza");
  assert.equal(empty.team[0].perm, "Proprietário");

  const sorriso = await createClient(sql, agencyId, dona, { name: "Clínica Sorriso", segment: "Saúde", monthly_fee: 3500, owner_user_id: dona, goal_metric: "CPL", goal_value: 20 });
  const loja = await createClient(sql, agencyId, dona, { name: "Loja Verde", monthly_fee: 2000, goal_metric: "ROAS", goal_value: 4 });
  await createClient(sql, agencyId, dona, { name: "Sem Meta", status: "onboarding" });

  // Janela atual: 20/set a 18/out. Anterior: 21/ago a 19/set.
  await metric(agencyId, sorriso.id, "2026-10-18", "a", 300, 10);
  await metric(agencyId, sorriso.id, "2026-10-01", "b", 200, 0);
  await metric(agencyId, sorriso.id, "2026-09-10", "a", 400, 25);
  await metric(agencyId, sorriso.id, "2026-10-19", "a", 999, 1); // hoje não entra
  await metric(agencyId, loja.id, "2026-10-17", "shop", 1000, 30, 3000, "google");
  await sql.query(
    `insert into client_ad_accounts (agency_id, client_id, platform, external_id, name, last_sync_error) values ($1, $2, 'google', '123', 'Loja', 'token vencido')`,
    [agencyId, loja.id],
  );

  const p = await agencyPortal(sql, agencyId, dona, NOW);
  assert.deepEqual(p.period, { from: "2026-09-19", to: "2026-10-18" });
  const s = p.clients.find((c) => c.id === sorriso.id)!;
  assert.deepEqual([s.gt, s.goal, s.cur, s.mrr, s.owner, s.ini, s.spend30], ["CPL", 20, 50, 3500, "Ana Souza", "CS", 500]);
  assert.match(s.reasons.join("|"), /CPL 150% acima da meta/);
  const l = p.clients.find((c) => c.id === loja.id)!;
  assert.deepEqual([l.gt, l.cur], ["ROAS", 3]);
  assert.match(l.reasons.join("|"), /Erro ao sincronizar/);
  const none = p.clients.find((c) => c.name === "Sem Meta")!;
  assert.equal(none.cur, null);
  assert.match(none.reasons.join("|"), /Meta de CPL, CPA ou ROAS não definida/);

  assert.equal(p.camps.length, 3);
  const shop = p.camps.find((c) => c.name === "Campanha shop")!;
  assert.deepEqual([shop.plat, shop.status, shop.spend, shop.conv, shop.rev], ["Google", "Ativa", 1000, 30, 3000]);
  const b = p.camps.find((c) => c.name === "Campanha b")!;
  assert.deepEqual([b.status, b.target, b.cpa], ["Pausada", 20, 0]);
  assert.deepEqual(p.plat, [["Google", 1000, 30, 3000], ["Meta", 500, 10, 0]]);
  assert.deepEqual(p.daily.map((d) => d.day), ["2026-09-10", "2026-10-01", "2026-10-17", "2026-10-18"]);

  assert.deepEqual(p.kpis.spend, { cur: 1500, prev: 400 });
  assert.deepEqual(p.kpis.results, { cur: 40, prev: 25 });
  assert.equal(p.kpis.mrr, 5500);
  assert.equal(p.kpis.activeClients, 3);
  const kinds = p.attention.map((a) => `${a.kind}:${a.client}`);
  assert.ok(kinds.includes("Campanha:Clínica Sorriso") && kinds.includes("Campanha:Loja Verde") && kinds.includes("Integração:Loja Verde"), kinds.join(","));
});
