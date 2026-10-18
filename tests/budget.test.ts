import assert from "node:assert/strict";
import { before, test } from "node:test";
import { dayIn, reserveBudget, settleBudget } from "../src/lib/xodos/budget";
import { num, type Sql } from "../src/lib/xodos/db";
import { refreshFx, usdBrl } from "../src/lib/xodos/fx";
import { createTestDb, seedAgency, seedXodo } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

const notifications = (agencyId: string) =>
  sql.query<{ kind: string; body: string }>(`select kind, body from notifications where agency_id = $1 order by id`, [agencyId]);

test("o dia do gasto segue o fuso do xodó", () => {
  const at = new Date("2026-10-19T02:30:00Z");
  assert.equal(dayIn("America/Sao_Paulo", at), "2026-10-18");
  assert.equal(dayIn("UTC", at), "2026-10-19");
});

test("sem teto, só registra o gasto do dia e nunca bloqueia", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId);
  const reservation = await reserveBudget(sql, xodo, "2026-10-19", 1_000_000);
  assert.deepEqual(reservation, { ok: true, spent: 0, reserved: 0, cap: null });
  await settleBudget(sql, xodo, "2026-10-19", 0, 12.5);
  await settleBudget(sql, xodo, "2026-10-19", 0, 7.25);
  const [row] = await sql.query(`select spent_brl, reserved_brl from xodo_budget_days where xodo_id = $1`, [xodo.id]);
  assert.equal(num(row.spent_brl), 19.75);
  assert.equal(num(row.reserved_brl), 0);
  assert.deepEqual(await notifications(agencyId), []);
});

test("com teto em reais: reserva, acerta e avisa uma vez ao passar do percentual", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, { daily_budget_brl: 10 });
  const day = "2026-10-19";

  assert.deepEqual(await reserveBudget(sql, xodo, day, 5), { ok: true, spent: 0, reserved: 5, cap: 10 });
  assert.deepEqual(await settleBudget(sql, xodo, day, 5, 3), { spent: 3, cap: 10, warned: false });
  await reserveBudget(sql, xodo, day, 5);
  assert.equal((await settleBudget(sql, xodo, day, 5, 5)).warned, true);
  await reserveBudget(sql, xodo, day, 1);
  assert.equal((await settleBudget(sql, xodo, day, 1, 0.5)).warned, false, "o aviso sai uma vez só por dia");

  const [row] = await sql.query(`select spent_brl, reserved_brl from xodo_budget_days where xodo_id = $1`, [xodo.id]);
  assert.equal(num(row.spent_brl), 8.5);
  assert.equal(num(row.reserved_brl), 0);
  const [warning] = await notifications(agencyId);
  assert.equal(warning.kind, "budget_warning");
  assert.match(warning.body, /R\$\s?8,00 de R\$\s?10,00/);
});

test("com teto: recusa quando a reserva não cabe e avisa uma vez que pausou", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, { daily_budget_brl: 10 });
  const day = "2026-10-19";

  assert.equal((await reserveBudget(sql, xodo, day, 7)).ok, true);
  // Conta o que já está reservado por outra chamada em andamento.
  assert.deepEqual(await reserveBudget(sql, xodo, day, 4), { ok: false, spent: 0, reserved: 7, cap: 10 });
  assert.equal((await reserveBudget(sql, xodo, day, 4)).ok, false);
  assert.deepEqual((await notifications(agencyId)).map((n) => n.kind), ["budget_capped"]);
  // Outro dia começa do zero.
  assert.equal((await reserveBudget(sql, xodo, "2026-10-20", 9)).ok, true);
});

test("reservas simultâneas não estouram o teto", async () => {
  const { agencyId } = await seedAgency(sql);
  const xodo = await seedXodo(sql, agencyId, { daily_budget_brl: 10 });
  const results = await Promise.all(Array.from({ length: 10 }, () => reserveBudget(sql, xodo, "2026-10-19", 3)));
  assert.equal(results.filter((r) => r.ok).length, 3);
});

test("cotação do dólar: grava a PTAX de cada dia e usa a última conhecida no fim de semana", async () => {
  const { sql: db } = await createTestDb();
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return new Response(
      JSON.stringify({
        value: [
          { cotacaoCompra: 5.4, cotacaoVenda: 5.41, dataHoraCotacao: "2026-10-15 13:09:28.123" },
          { cotacaoCompra: 5.5, cotacaoVenda: 5.52, dataHoraCotacao: "2026-10-16 13:04:30.528" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  assert.equal(await usdBrl(db, "2026-10-18"), null);
  assert.equal(await refreshFx(db, new Date("2026-10-18T12:00:00Z"), fakeFetch), 2);
  assert.match(decodeURIComponent(calls[0]), /olinda\.bcb\.gov\.br.*'10-08-2026'.*'10-18-2026'/);
  // Domingo usa a cotação de sexta.
  assert.equal(await usdBrl(db, "2026-10-18"), 5.52);
  assert.equal(await usdBrl(db, "2026-10-15"), 5.41);

  const failing = (async () => new Response("erro", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(refreshFx(db, new Date(), failing), /503/);
});
