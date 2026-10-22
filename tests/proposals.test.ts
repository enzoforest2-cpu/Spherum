import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { listContracts } from "../src/lib/core/contracts";
import { createDeal, crmBoard } from "../src/lib/core/crm";
import { acceptProposal, createProposal, declineProposal, deleteProposal, listProposals, sendProposal, updateProposal, viewProposal } from "../src/lib/core/proposals";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function user(email: string, name?: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(name ? { full_name: name } : {})]))!.id;
}

test("proposta: do negócio ao aceite pelo link (cliente, contrato) e recusa", async () => {
  const dona = await user(`dona-${randomUUID()}@x.com`, "Ana Souza");
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Propostas" });
  const now = new Date("2026-10-21T15:00:00Z");
  const deal = await createDeal(sql, agencyId, dona, { company: "Studio Move", contact_name: "Renata", email: "renata@move.com", value: 2000, stage: "diagnostico" });

  const p = await createProposal(sql, agencyId, dona, { company: "Studio Move", contact_name: "Renata", email: "renata@move.com", deal_id: deal.id,
    doc: { items: [{ n: "Gestão de tráfego", u: "mês", p: 1500, q: 1 }], payDay: 5 }, monthly_cents: 240000, term_months: 6 });
  assert.equal(p.number, 1);
  assert.equal((await crmBoard(sql, agencyId, now)).deals[0].stage, "proposta", "criar a proposta leva o negócio para proposta");
  await updateProposal(sql, agencyId, p.id, { monthly_cents: 250000, doc: { items: [{ n: "Gestão de tráfego", u: "mês", p: 2500, q: 1 }], payDay: 5 } });

  const s1 = await sendProposal(sql, agencyId, dona, p.id, 15, now);
  const s2 = await sendProposal(sql, agencyId, dona, p.id, 15, now);
  await assert.rejects(viewProposal(sql, s1.token, now), /não encontrada/, "reenviar troca o link");
  const seen = await viewProposal(sql, s2.token, now);
  await viewProposal(sql, s2.token, now);
  assert.deepEqual([seen.status, seen.number, seen.monthly_cents, seen.valid_until], ["enviada", "P-0001", 250000, "2026-11-05"]);
  let list = await listProposals(sql, agencyId, now);
  assert.deepEqual([list.proposals[0].views, list.proposals[0].expired], [2, false]);
  const notes = await sql.query<{ kind: string }>(`select kind from notifications where agency_id = $1 and kind like 'proposta%'`, [agencyId]);
  assert.equal(notes.length, 1, "só a primeira visualização avisa");

  await assert.rejects(acceptProposal(sql, s2.token, { name: "Re", email: "x@y.com", agree: true }, "1.2.3.4", now));
  await acceptProposal(sql, s2.token, { name: "Renata Alves", email: "Renata@Move.com", agree: true }, "1.2.3.4", now);
  await assert.rejects(acceptProposal(sql, s2.token, { name: "Renata Alves", email: "renata@move.com", agree: true }, null, now), /já foi aceita/);
  list = await listProposals(sql, agencyId, now);
  const acc = list.proposals[0];
  assert.deepEqual([acc.status, acc.accepted_name, acc.accepted_email, !!acc.client_id, !!acc.contract_id], ["aceita", "Renata Alves", "renata@move.com", true, true]);
  const ip = await one<{ accepted_ip: string }>(sql, `select accepted_ip from proposals where id = $1`, [p.id]);
  assert.equal(ip!.accepted_ip, "1.2.3.4");
  const board = await crmBoard(sql, agencyId, now);
  assert.equal(board.deals[0].stage, "ganho", "aceite ganha o negócio");
  const [k] = await listContracts(sql, agencyId, now);
  assert.deepEqual([k.monthly_fee_cents, k.client_id], [250000, acc.client_id]);
  await assert.rejects(deleteProposal(sql, agencyId, dona, p.id), /não pode ser apagada/);
  await updateProposal(sql, agencyId, p.id, { company: "Outro nome", doc: { adds: [{ k: "A-01" }] } });
  assert.equal((await listProposals(sql, agencyId, now)).proposals[0].company, "Studio Move", "aceita: só o doc muda");

  // Sem negócio: recusa; e validade vencida.
  const p2 = await createProposal(sql, agencyId, dona, { company: "Café Grão", monthly_cents: 180000 });
  const s3 = await sendProposal(sql, agencyId, dona, p2.id, 5, now);
  await declineProposal(sql, s3.token, "Vamos esperar o fim do ano", now);
  await assert.rejects(acceptProposal(sql, s3.token, { name: "Otávio Brandão", email: "o@c.com", agree: true }, null, now), /não está mais aberta/);
  const p3 = await createProposal(sql, agencyId, dona, { company: "Pet Feliz", monthly_cents: 90000 });
  const s4 = await sendProposal(sql, agencyId, dona, p3.id, 1, now);
  const later = new Date("2026-10-25T12:00:00Z");
  assert.equal((await viewProposal(sql, s4.token, later)).status, "vencida");
  await assert.rejects(acceptProposal(sql, s4.token, { name: "Pet Dono", email: "p@f.com", agree: true }, null, later), /validade/);
  list = await listProposals(sql, agencyId, later);
  assert.deepEqual([list.stats.accept_rate, list.proposals.find((x) => x.id === p3.id)!.expired], [50, true]);
});
