import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createAgency, me, slugify, updateAgency } from "../src/lib/core/agencies";
import { addContact, createClient, getClient, listClients, setClientArchived, updateClient } from "../src/lib/core/clients";
import { bookedSlots, createLead, protocolOf } from "../src/lib/core/leads";
import { acceptInvite, inviteClientUser, inviteMember, listInvites, listMembers, maskEmail, previewInvite, removeMember, revokeInvite, updateMember } from "../src/lib/core/team";
import { one, type Sql } from "../src/lib/xodos/db";
import { Clock, createTestDb } from "./helpers";

let db: PGlite;
let sql: Sql;
before(async () => {
  ({ db, sql } = await createTestDb());
});

/** Usuário do Supabase Auth (o gatilho cria o perfil com o nome do cadastro). */
async function user(email: string, meta: Record<string, unknown> = {}) {
  const row = await one<{ id: string }>(sql, `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [
    email,
    JSON.stringify(meta),
  ]);
  return { id: row!.id, email };
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  await db.query(`set role authenticated`);
  try {
    return await fn();
  } finally {
    await db.query(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

test("cadastro: cria a agência com a pessoa como dona, com o perfil do cadastro e endereço único", async () => {
  const ana = await user(`ana-${randomUUID()}@exemplo.com`, { full_name: "Ana Souza", phone: "11 99999-0000" });
  const agency = await createAgency(sql, ana.id, {
    name: "Marketing Pró",
    state: "sp",
    onboarding: { mode: "agency", clients: "11 a 30", plats: ["Meta", "Google"], goals: ["Relatórios automáticos"], recommended_plan: "escala" },
  });
  assert.match(agency.slug, /^marketing-pro(-\d+)?$/);
  const again = await createAgency(sql, ana.id, { name: "Marketing Pró" });
  assert.notEqual(again.slug, agency.slug, "endereço não repete");
  const row = await one<{ plan: string; state: string; plan_status: string; onboarding: { plats: string[] } }>(
    sql,
    `select plan, state, plan_status, onboarding from agencies where id = $1`,
    [agency.id],
  );
  assert.deepEqual([row!.plan, row!.state, row!.plan_status, row!.onboarding.plats], ["escala", "SP", "trial", ["Meta", "Google"]]);
  const who = await me(sql, ana);
  assert.equal(who.user.full_name, "Ana Souza");
  assert.equal(who.home, "agencia");
  assert.deepEqual(who.agencies.find((a) => a.agency_id === agency.id)?.role, "owner");
  assert.equal(slugify("  Agência São João & Cia! "), "agencia-sao-joao-cia");

  const alone = await user(`sem-${randomUUID()}@exemplo.com`);
  assert.equal((await me(sql, alone)).home, "cadastro");
  for (let i = 0; i < 3; i += 1) await createAgency(sql, ana.id, { name: `Extra ${i}` });
  await assert.rejects(createAgency(sql, ana.id, { name: "Sexta" }), /5 agências/);

  const updated = await updateAgency(sql, agency.id, ana.id, { cnpj: "12.345.678/0001-90", brand_color: "#EF5B3B" });
  assert.equal(updated.cnpj, "12345678000190");
  await assert.rejects(updateAgency(sql, agency.id, ana.id, { cnpj: "123" }), /14 dígitos/);
});

test("equipe: convite por link vale só para o e-mail convidado, uma vez, por 7 dias", async () => {
  const clock = new Clock(new Date());
  const dona = await user(`dona-${randomUUID()}@exemplo.com`);
  const { id: agencyId } = await createAgency(sql, dona.id, { name: "Agência Convites" });
  const email = `beto-${randomUUID()}@exemplo.com`;
  const invite = await inviteMember(sql, agencyId, { id: dona.id, role: "owner" }, { email: email.toUpperCase(), role: "member" }, clock.now);
  assert.equal(invite.email, email);
  const stored = await one<{ token_hash: string }>(sql, `select token_hash from invites where id = $1`, [invite.id]);
  assert.notEqual(stored!.token_hash, invite.token, "só o hash fica no banco");

  const preview = await previewInvite(sql, invite.token, clock.now);
  assert.equal(preview.agency_name, "Agência Convites");
  assert.equal(preview.email_hint, maskEmail(email));
  assert.ok(!preview.email_hint.includes(email.split("@")[0]));

  const intruso = await user(`intruso-${randomUUID()}@exemplo.com`);
  await assert.rejects(acceptInvite(sql, intruso, invite.token, clock.now), /Este convite é para/);
  const beto = await user(email);
  const accepted = await acceptInvite(sql, { id: beto.id, email: email.toUpperCase() }, invite.token, clock.now);
  assert.deepEqual([accepted.kind, accepted.role], ["equipe", "member"]);
  await assert.rejects(acceptInvite(sql, beto, invite.token, clock.now), /já usado/);
  const members = await listMembers(sql, agencyId);
  assert.deepEqual(members.map((m) => m.role), ["owner", "member"]);
  assert.equal(members[1].email, email);
  await assert.rejects(inviteMember(sql, agencyId, { id: dona.id, role: "owner" }, { email, role: "viewer" }), /já está na equipe/);

  // Vencido não serve; convite novo para o mesmo e-mail substitui o anterior.
  const carla = `carla-${randomUUID()}@exemplo.com`;
  const old = await inviteMember(sql, agencyId, { id: dona.id, role: "owner" }, { email: carla }, clock.now);
  const fresh = await inviteMember(sql, agencyId, { id: dona.id, role: "owner" }, { email: carla }, clock.now);
  await assert.rejects(previewInvite(sql, old.token, clock.now), /inválido/);
  assert.deepEqual((await listInvites(sql, agencyId, clock.now)).map((i) => i.id), [fresh.id]);
  clock.advance(8 * 24 * 3_600_000);
  await assert.rejects(acceptInvite(sql, await user(carla), fresh.token, clock.now), /vencido/);
  await revokeInvite(sql, agencyId, dona.id, fresh.id, clock.now);
  await assert.rejects(revokeInvite(sql, agencyId, dona.id, fresh.id, clock.now), /já usado/);

  // Quem não tem acesso total não convida para um cargo com mais acesso que o seu.
  await assert.rejects(inviteMember(sql, agencyId, { id: beto.id, role: "member" }, { email: "x@y.com", role: "admin" }), /não permite convidar|mais acesso do que tem/);
});

test("equipe: papéis e saída respeitam o dono, e a agência nunca fica sem dono", async () => {
  const dona = await user(`d-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona.id, { name: "Papéis" });
  const admin = randomUUID();
  const membro = randomUUID();
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')`, [agencyId, admin, membro]);

  await assert.rejects(updateMember(sql, agencyId, { id: admin, role: "admin" }, dona.id, { role: "member" }), /Só o dono/);
  await assert.rejects(updateMember(sql, agencyId, { id: membro, role: "member" }, admin, { role: "viewer" }), /não permite mudar a equipe/);
  await updateMember(sql, agencyId, { id: admin, role: "admin" }, membro, { role: "viewer", title: "Estagiário" });
  await assert.rejects(updateMember(sql, agencyId, { id: dona.id, role: "owner" }, dona.id, { role: "admin" }), /pelo menos um dono/);
  await assert.rejects(removeMember(sql, agencyId, { id: dona.id, role: "owner" }, dona.id), /pelo menos um dono/);
  await assert.rejects(removeMember(sql, agencyId, { id: membro, role: "viewer" }, admin), /não permite/);

  // Passa a posse e depois sai.
  await updateMember(sql, agencyId, { id: dona.id, role: "owner" }, admin, { role: "owner" });
  await removeMember(sql, agencyId, { id: dona.id, role: "owner" }, dona.id);
  await removeMember(sql, agencyId, { id: membro, role: "viewer" }, membro);
  const left = await sql.query<{ role: string }>(`select role from agency_members where agency_id = $1`, [agencyId]);
  assert.deepEqual(left.map((r) => r.role), ["owner"]);
  const log = await sql.query<{ action: string }>(`select action from audit_events where agency_id = $1 order by id`, [agencyId]);
  assert.ok(log.some((l) => l.action === "papel_alterado") && log.some((l) => l.action === "saiu_da_agencia"));
});

test("clientes: cadastro com mensalidade em reais, contato principal, responsável da equipe e arquivo", async () => {
  const dona = await user(`c-${randomUUID()}@x.com`, { full_name: "Dona" });
  const { id: agencyId } = await createAgency(sql, dona.id, { name: "Clientes" });
  const outra = await createAgency(sql, (await user(`o-${randomUUID()}@x.com`)).id, { name: "Outra" });

  const verano = await createClient(sql, agencyId, dona.id, { name: "Loja Verano", segment: "Varejo", monthly_fee: 2490.5, owner_user_id: dona.id, cnpj: "12.345.678/0001-90" });
  assert.equal(verano.monthly_fee, 2490.5);
  assert.equal(verano.owner_name, "Dona");
  assert.equal(verano.cnpj, "12345678000190");
  await assert.rejects(createClient(sql, agencyId, dona.id, { name: "X", owner_user_id: randomUUID() }), /da equipe/);

  await addContact(sql, agencyId, verano.id, { name: "Marcelo", email: "Marcelo@Verano.com" });
  await addContact(sql, agencyId, verano.id, { name: "Júlia", is_primary: true });
  const full = await getClient(sql, agencyId, verano.id);
  assert.deepEqual(full.contacts.map((c) => [c.name, c.is_primary]), [["Júlia", true], ["Marcelo", false]]);
  assert.equal(full.contacts[1].email, "marcelo@verano.com");
  await assert.rejects(addContact(sql, outra.id, verano.id, { name: "Invasor" }), /não encontrado/);

  const changed = await updateClient(sql, agencyId, dona.id, verano.id, { status: "pausado", monthly_fee: null });
  assert.deepEqual([changed.status, changed.monthly_fee], ["pausado", null]);
  await assert.rejects(updateClient(sql, outra.id, dona.id, verano.id, { name: "Roubado" }), /não encontrado/);

  await setClientArchived(sql, agencyId, dona.id, verano.id, true);
  assert.equal((await listClients(sql, agencyId)).length, 0);
  assert.equal((await listClients(sql, agencyId, { archived: true })).length, 1);
  await setClientArchived(sql, agencyId, dona.id, verano.id, false);
  assert.equal((await listClients(sql, agencyId)).length, 1);
});

test("portal do cliente: convite dá acesso só àquele cliente; RLS separa agência e cliente", async () => {
  const dona = await user(`p-${randomUUID()}@x.com`);
  const { id: agencyId } = await createAgency(sql, dona.id, { name: "Portal" });
  const pilar = await createClient(sql, agencyId, dona.id, { name: "Construtora Pilar" });
  const outro = await createClient(sql, agencyId, dona.id, { name: "Outro Cliente" });
  const email = `marcelo-${randomUUID()}@pilar.com`;
  const invite = await inviteClientUser(sql, agencyId, pilar.id, dona.id, { email });
  assert.equal((await previewInvite(sql, invite.token)).client_name, "Construtora Pilar");
  const marcelo = await user(email);
  await acceptInvite(sql, marcelo, invite.token);
  const who = await me(sql, marcelo);
  assert.equal(who.home, "cliente");
  assert.deepEqual(who.portals.map((p) => p.client_name), ["Construtora Pilar"]);

  await asUser(marcelo.id, async () => {
    const clients = await db.query<{ name: string }>(`select name from clients`);
    assert.deepEqual(clients.rows.map((c) => c.name), ["Construtora Pilar"]);
    assert.equal((await db.query(`select id, name from agencies`)).rows.length, 1);
    assert.equal((await db.query(`select * from agency_members`)).rows.length, 0, "cliente não vê a equipe");
    await assert.rejects(db.query(`select onboarding from agencies`), /permission denied/);
    await assert.rejects(db.query(`select * from invites`), /permission denied/);
  });
  await asUser(dona.id, async () => {
    assert.equal((await db.query(`select id from clients`)).rows.length, 2);
    assert.equal((await db.query(`select * from client_portal_users`)).rows.length, 1);
    await assert.rejects(db.query(`update clients set name = 'x' where id = $1`, [outro.id]), /permission denied/);
    await assert.rejects(db.query(`select * from site_leads`), /permission denied/);
  });
});

test("site: contato e demonstração gravam, avisam o comercial, travam o horário e limitam abuso", async () => {
  const now = new Date(Date.now() + 365 * 86_400_000);
  const sent: { to: string | string[]; subject: string; text: string }[] = [];
  const deps = { sql, salt: "sal", notifyTo: "comercial@spherum.com.br", now: () => now, mail: async (m: (typeof sent)[number]) => (sent.push(m), true) };
  const slot = new Date(now.getTime() + 2 * 86_400_000);
  slot.setUTCMinutes(0, 0, 0);
  const lead = await createLead(
    deps,
    { kind: "demonstracao", name: "Rita", email: "rita@agencia.com", company: "Agência Rita", scheduled_for: slot.toISOString(), details: { clients: "11 a 30", tools: ["RD", "Trello"] } },
    "200.1.1.1",
  );
  assert.match(lead.protocol, /^SPH-\d{4}-\d{5}$/);
  assert.equal(lead.protocol, protocolOf(lead.id, now));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Rita/);
  assert.match(sent[0].text, /tools: RD, Trello/);
  await assert.rejects(createLead(deps, { kind: "demonstracao", email: "outro@x.com", scheduled_for: slot.toISOString() }, "200.1.1.2"), /reservado/);
  assert.deepEqual(await bookedSlots(sql, now), [slot.toISOString().replace(".000Z", "Z")]);
  const stored = await one<{ ip_hash: string }>(sql, `select ip_hash from site_leads where id = $1`, [lead.id]);
  assert.ok(stored!.ip_hash && !stored!.ip_hash.includes("200.1"), "o IP não fica guardado");

  await assert.rejects(createLead(deps, { kind: "contato", name: "Sem contato" }, null), /e-mail ou telefone/);
  await assert.rejects(createLead(deps, { kind: "demonstracao", email: "a@b.com", scheduled_for: now.toISOString() }, null), /não está disponível/);
  for (let i = 0; i < 7; i += 1) await createLead(deps, { kind: "contato", email: `x${i}@y.com` }, "9.9.9.9");
  await createLead(deps, { kind: "contato", email: "ok@y.com" }, "9.9.9.9");
  await assert.rejects(createLead(deps, { kind: "contato", email: "z@y.com" }, "9.9.9.9"), /Muitos envios/);
});
