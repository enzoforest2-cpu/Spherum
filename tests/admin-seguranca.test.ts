import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { adminBoard, createIncident, recordCronRun, updateIncident, viewAgency, type AdminDeps } from "../src/lib/core/admin";
import { createAgency } from "../src/lib/core/agencies";
import { MFA_REQUIRED, requireStaff } from "../src/lib/core/http";
import { publicStatus } from "../src/lib/core/status";
import { openSupport } from "../src/lib/core/support";
import { one, type Sql } from "../src/lib/xodos/db";
import { XodoError } from "../src/lib/xodos/errors";
import { fail, tokenAal } from "../src/lib/xodos/http";
import { createTestDb, seedClient } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function user(email: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, last_sign_in_at) values ($1, now()) returning id`, [email]))!.id;
}

async function staff(role: string) {
  const id = await user(`${role}-${randomUUID()}@spherum.com.br`);
  await sql.query(`insert into spherum_staff (user_id, role) values ($1, $2)`, [id, role]);
  return { id, role };
}

const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const deps = (): AdminDeps => ({ sql, mail: async () => true, appUrl: "https://spherum.com.br" });

test("duas etapas: equipe com aal1 é recusada com mfa_required; aal2 entra; quem não é da equipe continua 404", async () => {
  const dono = await staff("dono");
  for (const aal of ["aal1", null]) {
    await assert.rejects(requireStaff(sql, { id: dono.id, aal }), (e: unknown) => e instanceof XodoError && e.status === 403 && e.code === MFA_REQUIRED);
  }
  assert.equal(await requireStaff(sql, { id: dono.id, aal: "aal2" }), "dono");

  const outsider = await user(`fora-${randomUUID()}@agencia.com`);
  await assert.rejects(requireStaff(sql, { id: outsider, aal: "aal2" }), (e: unknown) => e instanceof XodoError && e.status === 404);
  await assert.rejects(requireStaff(sql, { id: outsider, aal: "aal1" }), (e: unknown) => e instanceof XodoError && e.status === 404 && !e.code, "não revela que a rota é do admin");

  const res = fail(new XodoError("Confirme o código", 403, MFA_REQUIRED));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Confirme o código", code: MFA_REQUIRED });
});

test("duas etapas: o nível vem do claim aal do token", () => {
  assert.equal(tokenAal(jwt({ sub: "u", aal: "aal2" })), "aal2");
  assert.equal(tokenAal(jwt({ sub: "u", aal: "aal1" })), "aal1");
  assert.equal(tokenAal(jwt({ sub: "u" })), null);
  assert.equal(tokenAal("lixo"), null);
});

test("admin: a lista da equipe diz quem já cadastrou o app autenticador", async () => {
  const a = await staff("operacao"), b = await staff("leitura");
  await sql.query(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified'), ($2, 'unverified')`, [a.id, b.id]);
  const board = await adminBoard(sql, a.id, "operacao");
  assert.equal(board.staff.find((p) => p.user_id === a.id)?.mfa, true);
  assert.equal(board.staff.find((p) => p.user_id === b.id)?.mfa, false);
});

test("ver como a agência: só leitura, só suporte/operação/dono, na auditoria e com aviso à agência", async () => {
  const sup = await staff("suporte"), fin = await staff("financeiro");
  const ana = await user(`ana-${randomUUID()}@agencia.com`);
  const { id: agencyId } = await createAgency(sql, ana, { name: "Agência Vista" });
  await seedClient(sql, agencyId, "Cliente Um");
  await openSupport(sql, async () => true, agencyId, ana, { subject: "Relatório não abre", text: "O relatório de outubro não abre." });
  const ticket = (await one<{ id: string }>(sql, `select id from support_tickets where agency_id = $1`, [agencyId]))!.id;
  const before = await one<{ updated_at: string }>(sql, `select updated_at::text from agencies where id = $1`, [agencyId]);

  await assert.rejects(viewAgency(deps(), fin, agencyId, {}), /não permite/);
  const v = await viewAgency(deps(), sup, agencyId, { ticket });
  assert.equal(v.read_only, true);
  assert.equal(v.summary.agency.name, "Agência Vista");
  assert.equal(v.summary.clients.total, 1);
  assert.equal(v.summary.team.length, 1);
  assert.equal(v.summary.support[0].subject, "Relatório não abre");
  assert.equal("teamChat" in v.portal, false, "as conversas internas da agência ficam de fora");
  assert.equal(v.portal.me.user_id, ana, "vê o que o dono vê");

  const notes = await sql.query<{ title: string; body: string }>(`select title, body from notifications where agency_id = $1 and kind = 'spherum_acesso'`, [agencyId]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /abriu sua conta para atender o chamado “Relatório não abre”, só para ver/);
  const log = await sql.query<{ actor_user_id: string; summary: string }>(`select actor_user_id, summary from audit_events where agency_id = $1 and action = 'admin_ver_agencia'`, [agencyId]);
  assert.deepEqual(log.map((l) => l.actor_user_id), [sup.id]);

  await viewAgency(deps(), sup, agencyId, {});
  assert.equal((await sql.query(`select 1 from notifications where agency_id = $1 and kind = 'spherum_acesso'`, [agencyId])).length, 1, "um aviso por hora");
  assert.equal((await sql.query(`select 1 from audit_events where agency_id = $1 and action = 'admin_ver_agencia'`, [agencyId])).length, 2, "toda abertura entra na auditoria");
  assert.deepEqual(await one(sql, `select updated_at::text from agencies where id = $1`, [agencyId]), before, "a agência não muda");

  await assert.rejects(viewAgency(deps(), sup, agencyId, { ticket: randomUUID() }), /Chamado não encontrado/);
  await assert.rejects(viewAgency(deps(), sup, randomUUID(), {}), /Agência não encontrada/);
});

test("página pública de status: serviços pelo agendador, incidentes abertos e 30 dias de histórico, sem dados de agência", async () => {
  for (const t of ["status_updates", "status_incidents", "cron_runs"]) await sql.query(`delete from ${t}`);
  const now = new Date("2026-10-30T15:00:00Z");
  const op = await staff("operacao");
  const old = await createIncident(sql, op, { service: "pay", title: "Cobrança atrasada antiga", severity: "major", text: "Investigando atraso na cobrança." }, new Date("2026-09-01T12:00:00Z"));
  await updateIncident(sql, op, old.id, { status: "resolved", text: "Tudo normal de novo." }, new Date("2026-09-02T12:00:00Z"));
  const recent = await createIncident(sql, op, { service: "meta", title: "Campanhas do Meta sem atualizar", severity: "major", text: "O Meta está recusando as leituras." }, new Date("2026-10-20T12:00:00Z"));
  await updateIncident(sql, op, recent.id, { status: "resolved", text: "O Meta voltou a responder." }, new Date("2026-10-21T12:00:00Z"));
  await createIncident(sql, op, { service: "wa", title: "WhatsApp lento", severity: "minor", text: "Mensagens demorando alguns minutos." }, new Date("2026-10-30T13:00:00Z"));
  for (let k = 0; k < 10; k++) await recordCronRun(sql, new Date(now.getTime() - k * 15 * 60000), k < 3 ? { cobranca: "falhou: Asaas fora" } : { cobranca: "ok" });

  const s = await publicStatus(sql, now);
  assert.equal(s.overall, "minor");
  assert.deepEqual(s.open.map((i) => i.title), ["WhatsApp lento"]);
  assert.deepEqual(s.history.map((i) => i.title), ["Campanhas do Meta sem atualizar"], "o incidente de setembro fica de fora");
  assert.equal(s.history[0].updates.length, 2);
  const pay = s.services.find((x) => x.id === "pay")!, meta = s.services.find((x) => x.id === "meta")!, wa = s.services.find((x) => x.id === "wa")!;
  assert.equal(pay.uptime, 70);
  assert.equal(pay.bars.at(-1)!.state, "minor", "30% das execuções falharam hoje");
  assert.equal(pay.state, "ok", "sem incidente aberto, o serviço segue operando");
  assert.equal(meta.bars.find((b) => b.day === "2026-10-20")!.state, "major");
  assert.equal(meta.bars.at(-1)!.state, "ok");
  assert.equal(wa.state, "minor");
  assert.equal(s.services[0].bars.length, 30);
  assert.equal(s.services.find((x) => x.id === "google")!.bars[0].state, "none", "dia sem execução fica sem dados");
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /agency|author|created_by|@/, "nada de agência nem de quem escreveu");
});
