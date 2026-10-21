import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createAgency } from "../src/lib/core/agencies";
import { createClient } from "../src/lib/core/clients";
import { clientPortal } from "../src/lib/core/client-portal";
import {
  agencyCollabSummary, answerRequest, cancelRequest, clientCollab, createApproval, createRequest, createUpdate, decideApproval,
  recordActionUpdate, sendMessage, setPortalSettings, setUpdateStatus,
} from "../src/lib/core/collab";
import { createReport, setReportStatus } from "../src/lib/core/reports";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb, seedXodo } from "./helpers";

let db: PGlite;
let sql: Sql;
before(async () => {
  ({ db, sql } = await createTestDb());
});

async function user(email: string, name?: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(name ? { full_name: name } : {})]))!.id;
}

async function setup() {
  const dona = await user(`dona-${randomUUID()}@x.com`, "Ana Souza");
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Colab" });
  const c = await createClient(sql, agencyId, dona, { name: "Cliente Colab" });
  const cli = await user(`cli-${randomUUID()}@x.com`, "Rui");
  await sql.query(`insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3)`, [c.id, agencyId, cli]);
  return { dona, agencyId, clientId: c.id, cli };
}

test("feito pela agência: ação do xodó entra como rascunho (ou publicada com o automático), relatório publicado entra uma vez", async () => {
  const s = await setup();
  const xodo = await seedXodo(sql, s.agencyId, { name: "Nina" });
  await sql.query(
    `insert into metrics_daily (agency_id, client_id, platform, account_id, campaign_id, campaign_name, day) values ($1, $2, 'meta', 'a', 'c9', 'Leads Outubro', '2026-10-01')`,
    [s.agencyId, s.clientId],
  );
  const act = (toolName: string, extra: Record<string, unknown> = {}) =>
    recordActionUpdate(sql, { agencyId: s.agencyId, xodoId: xodo.id, actionId: randomUUID(), toolName, input: { client_id: s.clientId, campaign_id: "c9", plataforma: "meta", ...extra }, summary: "x" });
  await act("pausar_campanha");
  let c = await clientCollab(sql, s.clientId, "agencia");
  assert.deepEqual(c.updates.map((u) => [u.title, u.status, u.xodo_name]), [["Pausamos a campanha Leads Outubro", "rascunho", "Nina"]]);
  assert.equal((await clientCollab(sql, s.clientId, "cliente")).updates.length, 0, "rascunho não aparece para o cliente");
  const sum0 = await agencyCollabSummary(sql, s.agencyId);
  assert.equal(sum0.drafts, 1);
  assert.equal(sum0.draft_items[0].client_name, "Cliente Colab");

  await setPortalSettings(sql, s.agencyId, { auto_publicar: true });
  await act("ajustar_verba_diaria", { nova_verba_brl: 250 });
  c = await clientCollab(sql, s.clientId, "cliente");
  assert.deepEqual(c.updates.map((u) => [u.title, u.status]), [["Ajustamos a verba diária de Leads Outubro para R$ 250,00", "publicado"]]);

  const draft = (await clientCollab(sql, s.clientId, "agencia")).updates.find((u) => u.status === "rascunho")!;
  await setUpdateStatus(sql, s.agencyId, draft.id, "publicado", { title: "Pausamos o anúncio que estava caro", why: "CPL 40% acima da meta" });
  await createUpdate(sql, s.agencyId, s.dona, s.clientId, { title: "Reunião de alinhamento feita", kind: "equipe" });
  const rep = await createReport(sql, s.agencyId, s.dona, { client_id: s.clientId, title: "Outubro", period_start: "2026-10-01", period_end: "2026-10-31" });
  await setReportStatus(sql, s.agencyId, s.dona, rep.id, "published");
  await setReportStatus(sql, s.agencyId, s.dona, rep.id, "published");
  c = await clientCollab(sql, s.clientId, "cliente");
  assert.equal(c.updates.length, 4);
  assert.equal(c.updates.filter((u) => u.kind === "relatorio").length, 1, "relatório entra uma vez");
  assert.ok(c.updates.some((u) => u.title === "Pausamos o anúncio que estava caro" && u.why === "CPL 40% acima da meta"));
});

test("pendências, aprovações e conversa: só quem é do cliente responde; a agência é avisada; não lidas por lado", async () => {
  const s = await setup();
  const mails: string[] = [];
  const deps = { sql, mail: async (m: { subject: string }) => { mails.push(m.subject); return true; } };
  const estranho = await user(`x-${randomUUID()}@x.com`);

  const r1 = await createRequest(deps, s.agencyId, s.dona, s.clientId, { title: "Acesso ao Meta Business", kind: "passos", steps: ["Abra business.facebook.com", "Adicione a agência"] });
  const r2 = await createRequest(deps, s.agencyId, s.dona, s.clientId, { title: "Quem aprova os criativos?", kind: "texto" });
  const r3 = await createRequest(deps, s.agencyId, s.dona, s.clientId, { title: "Logo em alta", kind: "arquivo" });
  assert.equal(mails.length, 3);
  await assert.rejects(answerRequest(sql, estranho, r1.id, {}), /não encontrada/);
  await answerRequest(sql, s.cli, r1.id, {});
  await assert.rejects(answerRequest(sql, s.cli, r1.id, {}), /já foi resolvida/);
  await assert.rejects(answerRequest(sql, s.cli, r2.id, {}), /Escreva a resposta/);
  await answerRequest(sql, s.cli, r2.id, { response: "A Marina, 11 99999-0000" });
  await assert.rejects(answerRequest(sql, s.cli, r3.id, {}), /Envie o arquivo/);
  await cancelRequest(sql, s.agencyId, r3.id);
  let c = await clientCollab(sql, s.clientId, "cliente");
  assert.deepEqual(c.requests.map((r) => [r.title, r.status]).sort(), [["Acesso ao Meta Business", "feito"], ["Quem aprova os criativos?", "feito"]]);

  const a1 = await createApproval(deps, s.agencyId, s.dona, s.clientId, { title: "Criativos de novembro", link: "https://figma.com/x" });
  await assert.rejects(createApproval(deps, s.agencyId, s.dona, s.clientId, { title: "x", link: "http://inseguro.com" }));
  assert.equal((await agencyCollabSummary(sql, s.agencyId)).approvals, 1);
  await assert.rejects(decideApproval(sql, s.cli, a1.id, { decision: "alteracoes" }), /Conte o que precisa mudar/);
  await decideApproval(sql, s.cli, a1.id, { decision: "alteracoes", comment: "Trocar a foto do topo" });
  await assert.rejects(decideApproval(sql, s.cli, a1.id, { decision: "aprovado" }), /já foi decidida/);
  const sum = await agencyCollabSummary(sql, s.agencyId);
  assert.deepEqual([sum.approvals, sum.changes], [0, 1]);

  await sendMessage(deps, "agencia", s.agencyId, s.clientId, s.dona, { text: "Oi Rui, tudo certo?" });
  await sendMessage(deps, "cliente", s.agencyId, s.clientId, s.cli, { text: "Tudo! E o relatório?" });
  await sendMessage(deps, "cliente", s.agencyId, s.clientId, s.cli, { text: "Ah, e a fatura." });
  const sum2 = await agencyCollabSummary(sql, s.agencyId);
  assert.equal(sum2.unread[s.clientId], 2);
  assert.deepEqual(sum2.threads.map((t) => [t.client_id, t.side, t.text]), [[s.clientId, "cliente", "Ah, e a fatura."]]);
  c = await clientCollab(sql, s.clientId, "cliente");
  assert.equal(c.unread, 0, "o cliente leu ao escrever");
  assert.deepEqual(c.messages.map((m) => [m.side, m.author_name]), [["agencia", "Ana Souza"], ["cliente", "Rui"], ["cliente", "Rui"]]);
  const notes = await sql.query<{ kind: string }>(`select kind from notifications where agency_id = $1 order by id`, [s.agencyId]);
  assert.deepEqual(notes.map((n) => n.kind), ["pendencia_resolvida", "pendencia_resolvida", "ajuste_pedido_pelo_cliente", "mensagem_do_cliente", "mensagem_do_cliente"]);
  assert.equal((await clientPortal(sql, s.clientId, s.cli)).collab.messages.length, 3);

  // RLS: o cliente lê pelo banco só o que é dele e publicado.
  await createUpdate(sql, s.agencyId, s.dona, s.clientId, { title: "Rascunho interno", publish: false });
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [s.cli]);
  await db.query(`set role authenticated`);
  try {
    const seen = await db.query<{ title: string }>(`select title from client_updates`);
    assert.equal(seen.rows.length, 0);
    assert.equal((await db.query(`select 1 from client_messages`)).rows.length, 3);
  } finally {
    await db.query(`reset role`);
  }
});
