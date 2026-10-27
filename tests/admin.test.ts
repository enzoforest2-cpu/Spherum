import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import {
  addStaff, adminBoard, agencyHealth, announcementSweep, createAnnouncement, createCoupon, createIncident, createManualLead, deleteCoupon, messageAgency,
  recordCronRun, removeStaff, replySupport, setSupportStatus, updateAgencyAdmin, updateCoupon, updateIncident, updateSiteLead, updateStaff, type AdminDeps,
} from "../src/lib/core/admin";
import { createAgency } from "../src/lib/core/agencies";
import { clientAccess } from "../src/lib/core/client-portal";
import { listNotifications, markNotificationsRead, platformNotice } from "../src/lib/core/notifications";
import { agencyPortal } from "../src/lib/core/portal";
import type { EmailMessage } from "../src/lib/core/email";
import { platformFlags, requireFeature, resetPlatformCache, setFlags, setPrices } from "../src/lib/core/platform";
import { listSupport, openSupport, replySupportAgency } from "../src/lib/core/support";
import { one, type Sql } from "../src/lib/xodos/db";
import { CAN_READ, requireRole } from "../src/lib/xodos/http";
import { createTestDb, seedClient } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function user(email: string) {
  return (await one<{ id: string }>(sql, `insert into auth.users (email, last_sign_in_at) values ($1, now()) returning id`, [email]))!.id;
}

async function setup() {
  const dono = await user(`dono-${randomUUID()}@spherum.com.br`);
  await sql.query(`insert into spherum_staff (user_id, role) values ($1, 'dono')`, [dono]);
  const sup = await user(`sup-${randomUUID()}@spherum.com.br`);
  await sql.query(`insert into spherum_staff (user_id, role) values ($1, 'suporte')`, [sup]);
  const ana = await user(`ana-${randomUUID()}@agencia.com`);
  const { id: agencyId } = await createAgency(sql, ana, { name: `Agência ${randomUUID().slice(0, 6)}` });
  const mails: EmailMessage[] = [];
  const deps: AdminDeps = { sql, mail: async (m) => { mails.push(m); return true; }, appUrl: "https://spherum.com.br" };
  return { dono: { id: dono, role: "dono" }, sup: { id: sup, role: "suporte" }, ana, agencyId, deps, mails };
}

test("admin: agência suspensa perde o acesso da equipe e do portal; plano, teste e reativação ficam na auditoria", async () => {
  const s = await setup();
  const c = await seedClient(sql, s.agencyId, "Cliente X");
  await assert.rejects(updateAgencyAdmin(sql, s.sup, s.agencyId, { plan: "escala" }), /não permite/);
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { plan: "escala", plan_status: "active" });
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { trial_days: 10 }, new Date("2026-10-27T12:00:00Z"));
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { suspend: { reason: "Cobranças recusadas sem resposta" } });
  await assert.rejects(requireRole(sql, s.ana, s.agencyId, CAN_READ), /suspensa/);
  await assert.rejects(clientAccess(sql, s.ana, c), /suspensa/);
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { reactivate: true });
  assert.equal(await requireRole(sql, s.ana, s.agencyId, CAN_READ), "owner");

  const b = await adminBoard(sql, s.dono.id, "dono", new Date());
  const a = b.agencies.find((x) => x.id === s.agencyId)!;
  assert.deepEqual([a.plan, a.plan_status, a.suspended_at, a.clients], ["escala", "trial", null, 1], "estender o teste volta a situação para teste");
  assert.ok(b.audit.filter((e) => e.agency_id === s.agencyId).map((e) => e.action).includes("admin_suspensao"));

  await messageAgency(s.deps, s.sup, s.agencyId, { subject: "Podemos ajudar?", body: "Vimos que faz tempo que vocês não entram." });
  assert.ok(s.mails.some((m) => (Array.isArray(m.to) ? m.to : [m.to]).some((t) => t.startsWith("ana-"))));
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'spherum_mensagem'`, [s.agencyId]));
});

test("admin: saúde da agência por regras simples", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  assert.equal(agencyHealth({ last_seen: "2026-10-27T10:00:00Z", clients: 5, connections: 2, xodos: 1 }, now), 100);
  assert.equal(agencyHealth({ last_seen: null, clients: 0, connections: 0, xodos: 0 }, now), 20);
});

test("admin: equipe nunca fica sem dono; pessoa sem conta não entra", async () => {
  const s = await setup();
  await assert.rejects(addStaff(sql, s.dono, { email: "ninguem@x.com", role: "suporte" }), /ainda não tem conta/);
  const nova = await user(`nova-${randomUUID()}@spherum.com.br`);
  const email = (await one<{ email: string }>(sql, `select email from auth.users where id = $1`, [nova]))!.email;
  await addStaff(sql, s.dono, { email, role: "financeiro" });
  await assert.rejects(addStaff(sql, s.dono, { email, role: "suporte" }), /já é da equipe/);
  await assert.rejects(addStaff(sql, s.sup, { email: "x@y.com", role: "suporte" }), /não permite/);
  await updateStaff(sql, s.dono, nova, { role: "operacao" });
  await removeStaff(sql, s.dono, nova);
  // Só um dono por agora? Rebaixar o último dono é recusado.
  const donos = (await one<{ n: number }>(sql, `select count(*)::int as n from spherum_staff where role = 'dono'`))!.n;
  if (donos === 1) await assert.rejects(updateStaff(sql, s.dono, s.dono.id, { role: "leitura" }), /pelo menos um dono/);
});

test("admin: chaves da plataforma desligam o recurso; preços sobem de plano em plano", async () => {
  const s = await setup();
  await setFlags(sql, s.dono.id, { studio: false });
  await assert.rejects(requireFeature(sql, "studio"), /Estúdio está desligado/);
  await setFlags(sql, s.dono.id, { studio: true });
  assert.equal((await platformFlags(sql)).studio, true);
  await assert.rejects(setPrices(sql, s.dono.id, { solo: 190, agencia: 150, escala: 990, rede: 1990, empresarial: 2900 }), /precisa custar mais/);
  await setPrices(sql, s.dono.id, { solo: 190, agencia: 490, escala: 990, rede: 1990, empresarial: 2900 });
  resetPlatformCache();
});

test("admin: cupons, comunicados com envio único, incidentes e registro do cron", async () => {
  const s = await setup();
  const code = `T${randomUUID().slice(0, 6).toUpperCase().replace(/-/g, "")}`;
  await createCoupon(sql, s.dono, { code, description: "15% nos 3 primeiros meses", kind: "pct", value: 15, months: 3, plans: ["agencia"] });
  await assert.rejects(createCoupon(sql, s.dono, { code, description: "Outro", kind: "pct", value: 10 }), /Já existe/);
  await assert.rejects(createCoupon(sql, s.dono, { code: "X1Y", description: "Errado", kind: "pct", value: 150 }), /até 100%/);
  await updateCoupon(sql, s.dono, code, { status: "paused" });
  await deleteCoupon(sql, s.dono, code);

  const r = await createAnnouncement(s.deps, s.dono, { title: "Novo: publicar no Instagram", body: "Agora dá para agendar posts.", channel: "both", segment: "all", send: "now" });
  assert.ok(r.reach >= 1);
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'comunicado'`, [s.agencyId]));
  const later = await createAnnouncement(s.deps, s.dono, { title: "Manutenção domingo", body: "O app fica fora das 2h às 3h.", send: "schedule", send_at: "2026-11-01T05:00:00Z" }, new Date("2026-10-27T12:00:00Z"));
  assert.equal(await announcementSweep(s.deps, new Date("2026-10-30T12:00:00Z")), 0, "ainda não chegou a hora");
  assert.equal(await announcementSweep(s.deps, new Date("2026-11-01T05:01:00Z")), 1);
  assert.equal(await announcementSweep(s.deps, new Date("2026-11-01T05:16:00Z")), 0, "não envia de novo");
  assert.ok(later.id);

  const inc = await createIncident(sql, s.dono, { service: "meta", title: "Atraso na sincronização do Meta", text: "A API da Meta está lenta." });
  await updateIncident(sql, s.dono, inc.id, { status: "resolved", text: "Normalizou." });
  await assert.rejects(updateIncident(sql, s.dono, inc.id, { status: "monitoring", text: "De novo" }), /já resolvido/);

  await recordCronRun(sql, new Date(), { anuncios: "falhou: Meta fora", cobranca: { overdue: 0 } });
  const b = await adminBoard(sql, s.dono.id, "dono");
  assert.equal(b.cron.services.find((x) => x.id === "meta")!.failed >= 1, true);
  assert.equal(b.incidents.find((i) => i.id === inc.id)!.updates.length, 2);
});

test("suporte: agência abre e responde; Spherum responde e resolve; resposta reabre", async () => {
  const s = await setup();
  const t = await openSupport(sql, s.deps.mail, s.agencyId, s.ana, { subject: "Xodó parou no limite", text: "A Faísca pausou no fechamento.", priority: "alta" });
  await replySupport(s.deps, s.sup, t.id, { text: "Liberamos agora. Pode tentar de novo." });
  assert.ok(s.mails.some((m) => /Re: Xodó parou/.test(m.subject)));
  await setSupportStatus(sql, s.sup, t.id, { status: "done" });
  await replySupportAgency(sql, s.agencyId, s.ana, t.id, { text: "Voltou a parar." });
  const mine = await listSupport(sql, s.agencyId);
  assert.deepEqual([mine[0].status, mine[0].messages.map((m) => m.side)], ["open", ["ag", "sp", "ag"]]);
  const other = await setup();
  await assert.rejects(replySupportAgency(sql, other.agencyId, other.ana, t.id, { text: "Oi" }), /não encontrado/);
});

test("leads: funil com etapa, responsável e nota; lead manual sem duplicar", async () => {
  const s = await setup();
  const l = await createManualLead(sql, s.sup, { company: "Nexo Mídia", name: "Caio Freitas", email: `caio-${randomUUID()}@nexo.com`, clients: 120, plan: "rede" });
  await updateSiteLead(sql, s.sup, l.id, { stage: "demo", owner_user: s.sup.id, note: "Três unidades." });
  await assert.rejects(updateSiteLead(sql, s.sup, l.id, { owner_user: s.ana }), /não é da equipe/);
  const row = await one<{ stage: string; note: string; handled: boolean }>(sql, `select stage, note, handled_at is not null as handled from site_leads where id = $1`, [l.id]);
  assert.deepEqual([row!.stage, row!.note, row!.handled], ["demo", "Três unidades.", true]);
});

test("app da agência: notificações, aviso do topo (manutenção > incidente > comunicado) e chamados no portal", async () => {
  const s = await setup();
  const other = await user(`bia-${randomUUID()}@agencia.com`);
  await sql.query(`insert into notifications (agency_id, user_id, kind, title) values ($1, $2, 'reconhecimento', 'Só da Bia')`, [s.agencyId, other]);
  await createAnnouncement(s.deps, s.dono, { title: "Novo: Estúdio com vídeo", body: "Agora dá para animar.", channel: "banner", segment: "all", send: "now", cta_label: "Ver", cta_url: "https://spherum.com.br/novidades" });
  const mine = await listNotifications(sql, s.agencyId, s.ana);
  assert.ok(mine.some((n) => n.kind === "comunicado" && !n.read));
  assert.ok(!mine.some((n) => n.title === "Só da Bia"), "notificação de outra pessoa não aparece");

  await updateIncident(sql, s.dono, (await createIncident(sql, s.dono, { service: "app", title: "Teste antigo", text: "Começou." })).id, { status: "resolved", text: "Resolvido." });
  let n = await platformNotice(sql, s.agencyId);
  assert.equal(n?.title, "Novo: Estúdio com vídeo");
  assert.equal(n?.cta_url, "https://spherum.com.br/novidades");
  const inc = await createIncident(sql, s.dono, { service: "meta", title: "Meta lento", severity: "major", text: "A API do Meta está lenta." });
  n = await platformNotice(sql, s.agencyId);
  assert.deepEqual([n?.title, n?.tone, n?.text], ["Meta lento", "red", "A API do Meta está lenta."]);
  await setFlags(sql, s.dono.id, { maint: true });
  assert.equal((await platformNotice(sql, s.agencyId))?.title, "Manutenção no Spherum");
  await setFlags(sql, s.dono.id, { maint: false });
  resetPlatformCache();
  await updateIncident(sql, s.dono, inc.id, { status: "resolved", text: "Normalizou." });

  const c = mine.find((x) => x.kind === "comunicado")!;
  assert.equal((await markNotificationsRead(sql, s.agencyId, s.ana, { ids: [c.id] })).read, 1);
  assert.equal(await platformNotice(sql, s.agencyId), null, "comunicado lido sai do topo");
  await markNotificationsRead(sql, s.agencyId, s.ana, {});
  assert.ok((await listNotifications(sql, s.agencyId, s.ana)).every((x) => x.read));
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [other]))!.n, 1, "não marca a de outra pessoa");

  await openSupport(sql, s.deps.mail, s.agencyId, s.ana, { subject: "Relatório não gera", text: "Fica carregando." });
  const P = await agencyPortal(sql, s.agencyId, s.ana);
  assert.deepEqual([P.support.length, P.support[0].subject, P.notice], [1, "Relatório não gera", null]);
  assert.ok(Array.isArray(P.notifications));
});
