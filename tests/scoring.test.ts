import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { createDeal, crmBoard } from "../src/lib/core/crm";
import { DEFAULT_SCORING, scoreDeal, setDealFlags, setScoring } from "../src/lib/core/scoring";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("pontuação: critérios automáticos e manuais, faixas e limites de 0 a 100", async () => {
  const base = { value_cents: 0, source: null, segment: null, email: null, phone: null, notes: null };
  assert.deepEqual(scoreDeal(DEFAULT_SCORING, { ...base, value_cents: 500000, phone: "41", source: "indicacao" }), { score: 75, temp: "quente", reasons: ["valor", "telefone", "indicacao"] });
  assert.equal(scoreDeal(DEFAULT_SCORING, base).temp, "frio");

  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Score" });
  await assert.rejects(setScoring(sql, agencyId, { hot: 40, warm: 60, rules: [] }));
  await setScoring(sql, agencyId, { hot: 60, warm: 30, rules: [
    { k: "saude", l: "Segmento saúde", p: 20, kind: "segmento", value: "saude" },
    { k: "loja", l: "Tem loja física", p: 40, kind: "manual" },
    { k: "invest", l: "Investe mais de R$ 5 mil", p: 30, kind: "resposta", value: "R$ 5–20 mil" },
    { k: "spam", l: "Concorrente", p: -50, kind: "manual" },
  ] });
  const d = await createDeal(sql, agencyId, dona, { company: "Clínica Sorriso", segment: "Saúde", notes: "Quanto investe: R$ 5–20 mil" });
  let [row] = (await crmBoard(sql, agencyId)).deals;
  assert.deepEqual([row.score, row.temp], [50, "morno"]);
  await setDealFlags(sql, agencyId, d.id, ["loja"]);
  [row] = (await crmBoard(sql, agencyId)).deals;
  assert.deepEqual([row.score, row.temp, row.reasons], [90, "quente", ["saude", "loja", "invest"]]);
  await setDealFlags(sql, agencyId, d.id, ["loja", "spam", "spam"]);
  [row] = (await crmBoard(sql, agencyId)).deals;
  assert.equal(row.score, 40, "cada critério conta uma vez: 20 + 40 + 30 - 50");
  await setScoring(sql, agencyId, { hot: 60, warm: 30, rules: [{ k: "spam", l: "Concorrente", p: -50, kind: "manual" }] });
  assert.equal((await crmBoard(sql, agencyId)).deals[0].score, 0, "nunca abaixo de zero");
  await assert.rejects(setDealFlags(sql, randomUUID(), d.id, []), /não encontrado/);
});
