import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { clientPortal } from "../src/lib/core/client-portal";
import { createClient } from "../src/lib/core/clients";
import { createContract, noticeContract } from "../src/lib/core/contracts";
import { answerNps, markRiskHandled, requestNps, riskBoard } from "../src/lib/core/risk";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("radar: sinais somam risco, ação registrada baixa por 14 dias, NPS pedido e respondido no portal", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Risco" });
  const a = await createClient(sql, agencyId, dona, { name: "Academia Pulse", monthly_fee: 3200 });
  const b = await createClient(sql, agencyId, dona, { name: "Loja Verde", monthly_fee: 2000 });
  const cli = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`c-${randomUUID()}@x.com`]))!.id;
  await sql.query(`insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3)`, [a.id, agencyId, cli]);
  const now = new Date("2026-10-21T15:00:00Z");
  const k = await createContract(sql, agencyId, dona, { client_id: a.id, monthly_fee: 3200, start_date: "2026-01-01", end_date: "2027-01-01", billing: "nenhuma" }, now);
  await noticeContract(sql, agencyId, dona, k.id, { notice_end: "2026-11-30" }, now);

  const R = await requestNps(sql, agencyId, dona, { client_ids: [a.id, b.id], question: "De 0 a 10, quanto você nos recomendaria?" });
  assert.equal(R.requested, 2);
  assert.equal((await clientPortal(sql, a.id, cli)).nps!.question, "De 0 a 10, quanto você nos recomendaria?");
  await answerNps(sql, agencyId, a.id, cli, { score: 4, comment: "Resultados caíram" });
  assert.equal((await clientPortal(sql, a.id, cli)).nps, null, "respondeu: a pergunta some");

  const clients = [{ id: a.id, name: "Academia Pulse", mrr: 3200, fin: "Vencida", gap: 30 }, { id: b.id, name: "Loja Verde", mrr: 2000, fin: "Em dia", gap: null }];
  let board = await riskBoard(sql, agencyId, clients, now);
  const pulse = board.rows[0];
  assert.deepEqual([pulse.name, pulse.score, pulse.level, pulse.signals], ["Academia Pulse", 100, "alto", ["fatura vencida", "30% pior que a meta", "aviso prévio até 30/11", "NPS 4"]]);
  assert.deepEqual([board.rows[1].score, board.rows[1].nps_pending], [0, true]);
  assert.deepEqual([board.nps.answered, board.nps.detractors, board.nps.score, board.revenue_at_risk], [1, 1, -100, 3200]);

  await markRiskHandled(sql, agencyId, dona, a.id, "Liguei e combinei uma reunião");
  board = await riskBoard(sql, agencyId, clients, new Date());
  assert.deepEqual([board.rows[0].score, board.rows[0].level, board.rows[0].action!.note], [55, "medio", "Liguei e combinei uma reunião"]);
  board = await riskBoard(sql, agencyId, clients, new Date(Date.now() + 15 * 864e5));
  assert.equal(board.rows[0].score, 100, "passados 14 dias, volta ao normal");
});
