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
import { automationSweep } from "../src/lib/core/automations";
import { publishSweep } from "../src/lib/core/content";
import { decideAction } from "../src/lib/xodos/actions";
import { sendAnnouncement } from "../src/lib/core/admin";
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
  assert.deepEqual([a.plan, a.plan_status, a.suspended_at, a.clients], ["escala", "active", null, 1], "estender o teste de quem paga não muda a situação");
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
  assert.equal((await announcementSweep(s.deps, new Date("2026-10-30T12:00:00Z"))).sent, 0, "ainda não chegou a hora");
  assert.equal((await announcementSweep(s.deps, new Date("2026-11-01T05:01:00Z"))).sent, 1);
  assert.equal((await announcementSweep(s.deps, new Date("2026-11-01T05:16:00Z"))).sent, 0, "não envia de novo");
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

// ---------------------------------------------------------------------------
// Regressões da revisão de 27/10
// ---------------------------------------------------------------------------

test("revisão: suspensão vale nas regras de acesso do banco, nas aprovações por canal e nas varreduras", async () => {
  const s = await setup();
  const c = await seedClient(sql, s.agencyId, "Cliente RLS");
  const portal = await user(`cli-${randomUUID()}@cliente.com`);
  await sql.query(`insert into client_portal_users (client_id, agency_id, user_id) values ($1, $2, $3)`, [c, s.agencyId, portal]);
  const can = async (uid: string) => {
    await sql.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
    const r = (await one<{ m: boolean; cl: boolean }>(sql, `select public.app_is_agency_member($1) as m, public.app_is_client_user($2) as cl`, [s.agencyId, c]))!;
    await sql.query(`select set_config('request.jwt.claim.sub', '', false)`);
    return r;
  };
  assert.deepEqual([(await can(s.ana)).m, (await can(portal)).cl], [true, true]);

  // Post agendado e automação da agência, antes da suspensão.
  await sql.query(`insert into content_posts (agency_id, client_id, title, publish_at, status) values ($1, $2, 'Post', '2026-10-27T10:00:00Z', 'sched')`, [s.agencyId, c]);
  const auto = (await one<{ id: string }>(sql, `insert into automations (agency_id, name, trigger, steps, enabled, cursor_at) values ($1, 'Boas-vindas', '{"type":"formulario"}', '[]', true, '2026-10-01T00:00:00Z') returning id`, [s.agencyId]))!.id;

  await updateAgencyAdmin(sql, s.dono, s.agencyId, { suspend: { reason: "Teste de suspensão" } });
  assert.deepEqual([(await can(s.ana)).m, (await can(portal)).cl], [false, false], "quem é da agência suspensa não lê pela API do Supabase");

  await assert.rejects(decideAction({ sql } as never, { actionId: randomUUID(), agencyId: s.agencyId, userId: s.ana, approve: true, via: "slack" }), /suspensa/);

  const now = new Date("2026-10-27T12:00:00Z");
  const deps = { sql, publish: async () => { throw new Error("não devia publicar"); }, mediaUrls: async () => [], collab: {} } as never;
  const r = await publishSweep(deps, now);
  assert.deepEqual(r, { published: 0, failed: 0 }, "post de agência suspensa não sai");
  await automationSweep({ sql, mailer: async () => true } as never, now);
  const a = (await one<{ cursor_at: string; runs: number }>(sql, `select cursor_at::text, runs from automations where id = $1`, [auto]))!;
  assert.equal(Date.parse(a.cursor_at), now.getTime(), "eventos do período de suspensão não disparam depois");
  assert.equal(a.runs, 0);
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { reactivate: true });
});

test("revisão: chaves gravadas sem cache velho; mudanças na agência são tudo ou nada; teste de quem paga", async () => {
  const s = await setup();
  await setFlags(sql, s.dono.id, { xodo: true, studio: true, maint: false });
  await platformFlags(sql); // cache deste servidor
  // Outro servidor desliga o Estúdio; este ainda tem o valor antigo no cache.
  await sql.query(`update site_settings set value = value || '{"studio": false}'::jsonb where key = 'flags'`);
  const next = await setFlags(sql, s.dono.id, { maint: true });
  assert.deepEqual([next.studio, next.maint], [false, true], "mexer numa chave não religa outra");
  await setFlags(sql, s.dono.id, { studio: true, maint: false });
  resetPlatformCache();

  const fin = { id: s.dono.id, role: "financeiro" };
  await assert.rejects(updateAgencyAdmin(sql, fin, s.agencyId, { plan: "rede", suspend: { reason: "Sem pagamento" } }), /não permite/);
  assert.equal((await one<{ plan: string }>(sql, `select plan from agencies where id = $1`, [s.agencyId]))!.plan !== "rede", true, "nada foi gravado");
  await assert.rejects(updateAgencyAdmin(sql, s.dono, s.agencyId, { suspend: { reason: "Teste" }, reactivate: true }), /não os dois/);

  await updateAgencyAdmin(sql, s.dono, s.agencyId, { plan_status: "active" });
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { trial_days: 7 });
  assert.equal((await one<{ st: string }>(sql, `select plan_status as st from agencies where id = $1`, [s.agencyId]))!.st, "active");
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { plan_status: "past_due" });
  await updateAgencyAdmin(sql, s.dono, s.agencyId, { trial_days: 7 });
  assert.equal((await one<{ st: string }>(sql, `select plan_status as st from agencies where id = $1`, [s.agencyId]))!.st, "trial");
});

test("revisão: comunicado interrompido continua de onde parou e só fecha quando todos os e-mails saem", async () => {
  const s = await setup();
  const row = await createAnnouncement(s.deps, s.dono, { title: "Novidade por e-mail", body: "Texto do comunicado.", channel: "both", segment: "all", send: "draft" });
  const first = await sendAnnouncement(s.deps, row.id, new Date(), { deadline: Date.now() - 1 });
  assert.ok(first.reach >= 1);
  assert.equal(first.emailed, 0, "o prazo acabou antes dos e-mails");
  const st = async () => (await one<{ status: string }>(sql, `select status from announcements where id = $1`, [row.id]))!.status;
  assert.equal(await st(), "sending");
  assert.ok(await one(sql, `select 1 from notifications where agency_id = $1 and kind = 'comunicado' and data->>'announcement_id' = $2`, [s.agencyId, row.id]), "avisos no app já entraram");
  await assert.rejects(sendAnnouncement(s.deps, row.id), /já foi enviado/);
  await announcementSweep(s.deps, new Date());
  assert.equal(await st(), "sent");
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from announcement_deliveries where announcement_id = $1 and emailed_at is null`, [row.id]))!.n, 0);
  assert.equal((await one<{ n: number }>(sql, `select count(*)::int as n from notifications where agency_id = $1 and data->>'announcement_id' = $2`, [s.agencyId, row.id]))!.n, 1, "retomar não duplica o aviso");
});

test("revisão: resposta do suporte vai aos donos quando quem abriu saiu da agência", async () => {
  const s = await setup();
  const bia = await user(`bia-${randomUUID()}@agencia.com`);
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'member')`, [s.agencyId, bia]);
  const t = await openSupport(sql, s.deps.mail, s.agencyId, bia, { subject: "Dúvida da Bia", text: "Como faço?" });
  await sql.query(`delete from agency_members where agency_id = $1 and user_id = $2`, [s.agencyId, bia]);
  s.mails.length = 0;
  await replySupport(s.deps, s.sup, t.id, { text: "Assim, ó." });
  const notes = await sql.query<{ user_id: string | null }>(`select user_id from notifications where agency_id = $1 and kind = 'suporte_resposta'`, [s.agencyId]);
  assert.ok(notes.length >= 1 && notes.every((n) => n.user_id && n.user_id !== bia), "ninguém de fora nem aviso para todos");
  assert.ok(s.mails.every((m) => !(Array.isArray(m.to) ? m.to : [m.to]).some((x) => x.startsWith("bia-"))));
});

test("revisão: meses do admin pelo fuso de Brasília", async () => {
  const s = await setup();
  const b = await adminBoard(sql, s.dono.id, "dono", new Date("2026-11-01T01:30:00Z")); // 31/10, 22h30 em Brasília
  assert.equal(b.mrr.series[b.mrr.series.length - 1].m, "2026-10");
  assert.equal(b.metrics.signups[b.metrics.signups.length - 1].m, "2026-10");
});

test("alerta da equipe: etapa do agendador falhando duas vezes seguidas avisa uma vez", async () => {
  const { cronAlerts } = await import("../src/lib/core/alerts");
  const { recordCronRun } = await import("../src/lib/core/admin");
  const sent: string[] = [];
  const mail = async (m: { subject: string }) => { sent.push(m.subject); return true; };
  await sql.query(`delete from cron_runs`);
  await recordCronRun(sql, new Date(Date.now() - 900_000), { fila: "falhou: gateway fora", posts: 3 });
  assert.deepEqual(await cronAlerts(sql, mail, { ALERT_EMAIL: "ops@spherum.com.br" }), [], "uma falha só não avisa");
  await recordCronRun(sql, new Date(), { fila: "falhou: gateway fora", posts: 3 });
  assert.deepEqual(await cronAlerts(sql, mail, { ALERT_EMAIL: "ops@spherum.com.br" }), ["fila"]);
  await recordCronRun(sql, new Date(), { fila: "falhou: de novo", posts: 3 });
  assert.deepEqual(await cronAlerts(sql, mail, { ALERT_EMAIL: "ops@spherum.com.br" }), [], "não repete por 6 horas");
  assert.equal(sent.length, 1);
});
