import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { clientPortal } from "../src/lib/core/client-portal";
import { createClient } from "../src/lib/core/clients";
import { openTicket, replyTicket, setSla, ticketBoard, updateTicket } from "../src/lib/core/tickets";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function user(email: string, name?: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(name ? { full_name: name } : {})]))!.id;
}

test("chamado: cliente abre, prazo pela prioridade, primeira resposta, resolver, reabrir e números", async () => {
  const dona = await user(`dona-${randomUUID()}@x.com`, "Ana Souza");
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Chamados" });
  const c = await createClient(sql, agencyId, dona, { name: "Clínica Aurora", owner_user_id: dona });
  const cli = await user(`cli-${randomUUID()}@x.com`, "Carolina");
  await sql.query(`insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3)`, [c.id, agencyId, cli]);
  const mails: string[] = [];
  const deps = { sql, mail: async (m: { subject: string }) => { mails.push(m.subject); return true; } };
  const t0 = new Date("2026-10-21T12:00:00Z");

  await assert.rejects(openTicket(sql, agencyId, cli, "cliente", { client_id: c.id, subject: "Anúncio reprovado" }, t0), /Conte o que está acontecendo/);
  const k = await openTicket(sql, agencyId, cli, "cliente", { client_id: c.id, subject: "Anúncio reprovado", text: "O Meta reprovou o anúncio.", priority: "alta" }, t0);
  let board = await ticketBoard(sql, agencyId, t0);
  let tk = board.tickets[0];
  assert.deepEqual([tk.assignee_name, tk.source, tk.status, Date.parse(tk.due_at) - t0.getTime(), tk.messages.length], ["Ana Souza", "portal", "aberto", 2 * 3_600_000, 1], "sem responsável: quem cuida do cliente; prazo de 2 h");
  const note = await one<{ kind: string }>(sql, `select kind from notifications where agency_id = $1 order by id desc limit 1`, [agencyId]);
  assert.equal(note!.kind, "chamado_aberto");

  // Baixar a prioridade recalcula o prazo enquanto não houve resposta.
  await updateTicket(deps, agencyId, k.id, { priority: "baixa" });
  tk = (await ticketBoard(sql, agencyId, t0)).tickets[0];
  assert.equal(Date.parse(tk.due_at) - t0.getTime(), 24 * 3_600_000);

  await replyTicket(deps, agencyId, dona, "agencia", k.id, "Estou vendo agora.");
  await replyTicket(deps, agencyId, dona, "agencia", k.id, "Reenviei para revisão.");
  await updateTicket(deps, agencyId, k.id, { status: "resolvido" });
  assert.equal(mails.filter((m) => /resposta no chamado/.test(m)).length, 2);
  assert.ok(mails.some((m) => /chamado resolvido/.test(m)));
  board = await ticketBoard(sql, agencyId, new Date());
  tk = board.tickets[0];
  assert.deepEqual([tk.status, !!tk.first_response_at, tk.messages.map((m) => m.side)], ["resolvido", true, ["cliente", "agencia", "agencia"]]);
  assert.deepEqual([board.stats.open, board.stats.in_sla_pct, board.people[0].resolved, board.people[0].in_sla_pct], [0, 100, 1, 100]);

  // O cliente responde: reabre.
  await replyTicket(deps, agencyId, cli, "cliente", k.id, "Voltou a ser reprovado.");
  board = await ticketBoard(sql, agencyId, new Date());
  assert.equal(board.tickets[0].status, "aberto");

  // Prazo novo vale para os abertos sem resposta; o portal do cliente vê os chamados.
  const k2 = await openTicket(sql, agencyId, dona, "agencia", { client_id: c.id, subject: "Trocar foto", priority: "media" }, t0);
  await setSla(sql, agencyId, { alta: 1, media: 4, baixa: 48 });
  const due = (await ticketBoard(sql, agencyId, t0)).tickets.find((t) => t.id === k2.id)!.due_at;
  assert.equal(Date.parse(due) - t0.getTime(), 4 * 3_600_000);
  const portal = await clientPortal(sql, c.id, cli);
  assert.deepEqual(portal.tickets.map((t) => t.subject).sort(), ["Anúncio reprovado", "Trocar foto"]);
  await assert.rejects(updateTicket(deps, randomUUID(), k.id, { status: "resolvido" }), /não encontrado/);
});
