import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { addQuery, aivisBoard, analyze, runChecks, setClientSettings, tipToTask, type AivisDeps } from "../src/lib/core/aivis";
import { createClient } from "../src/lib/core/clients";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("análise da resposta: posição na lista, citação solta e concorrentes", () => {
  const ans = "Algumas opções:\n1. Instituto Belle — ótima\n2. Clínica Aurora, no Batel\n3. Dermacare";
  assert.deepEqual(analyze(ans, ["Clínica Aurora"], ["Instituto Belle", "Dermacare Curitiba", "Dermacare"]), { position: 2, mentioned: true, competitors: ["Instituto Belle", "Dermacare"] });
  assert.deepEqual(analyze("Recomendo a clinica aurora pelo atendimento.", ["Clínica Aurora"], []), { position: null, mentioned: true, competitors: [] });
  assert.deepEqual(analyze("1. Outra\n2. Mais uma", ["Clínica Aurora"], []), { position: null, mentioned: false, competitors: [] });
});

test("busca por IA: perguntas checadas em cada modelo, participação e tarefa", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência IA" });
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Aurora" });
  const answers: Record<string, string> = { openai: "1. Clínica Aurora\n2. Instituto Belle", google: "1. Instituto Belle\n2. Dermacare" };
  const deps: AivisDeps = { sql, engines: async () => ["openai", "google"], ask: async (_a, e) => { if (e === "google" && answers.google === "falha") throw new Error("cota"); return { answer: answers[e], model: e + "-mini" }; } };

  await setClientSettings(sql, agencyId, c.id, { competitors: ["Instituto Belle", "Dermacare"] });
  const q = await addQuery(sql, agencyId, dona, c.id, "melhor clínica de harmonização em Curitiba");
  await assert.rejects(addQuery(sql, agencyId, dona, c.id, "Melhor clínica de harmonização em Curitiba"), /já está/);
  assert.deepEqual(await runChecks(deps, agencyId, c.id), { checked: 2, failed: 0, engines: ["openai", "google"], partial: false });
  // A varredura semanal não refaz o que foi checado há menos de 6 dias.
  assert.equal((await runChecks(deps, agencyId, c.id, { onlyStale: true })).checked, 0);
  await sql.query(`update aivis_checks set checked_at = checked_at - interval '7 days' where query_id = $1`, [q.id]);
  assert.equal((await runChecks(deps, agencyId, c.id, { onlyStale: true, deadline: Date.now() + 10 })).partial, true, "sem prazo, nada é checado");
  assert.equal((await runChecks(deps, agencyId, c.id, { onlyStale: true })).checked, 2);

  let b = await aivisBoard(sql, agencyId, c.id, ["openai", "google"]);
  assert.deepEqual(b.engines.map((e) => e.name), ["ChatGPT", "Gemini"]);
  assert.deepEqual([b.queries[0].cells.openai!.position, b.queries[0].cells.google!.mentioned], [1, false]);
  assert.deepEqual(b.stats, { checked: 2, mentioned: 1, first: 1, share_pct: 25 });
  assert.deepEqual(b.share.map((s) => [s.name, s.pct]), [["Instituto Belle", 50], ["Clínica Aurora", 25], ["Dermacare", 25]]);
  assert.match(b.tips.join(" "), /avaliações/);

  // A checagem nova substitui a anterior na tabela; erro de um modelo fica registrado.
  answers.google = "falha";
  assert.equal((await runChecks(deps, agencyId, c.id)).failed, 1);
  b = await aivisBoard(sql, agencyId, c.id, ["openai", "google"]);
  assert.equal(b.queries[0].cells.google!.error, "cota");
  assert.equal(b.queries[0].id, q.id);

  const t = await tipToTask(sql, agencyId, dona, c.id, { title: "Página de harmonização", due_date: "2026-11-10" }, new Date("2026-10-22T12:00:00Z"));
  assert.ok(t);
  assert.equal((await one<{ name: string }>(sql, `select name from projects where client_id = $1`, [c.id]))!.name, "Presença nas buscas por IA · Clínica Aurora");
});
