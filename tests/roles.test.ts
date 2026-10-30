import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { agencyPortal } from "../src/lib/core/portal";
import { createRole, deleteRole, listRoles, memberAccess, normalizePerms, updateRole } from "../src/lib/core/roles";
import { acceptInvite, inviteMember, removeMember, updateMember } from "../src/lib/core/team";
import { one, type Sql } from "../src/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, CAN_USE, requireRole } from "../src/lib/xodos/http";
import { createTestDb } from "./helpers";

let sql: Sql;
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
before(async () => {
  ({ sql, db } = await createTestDb());
});

async function user(email: string) {
  const row = await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [email]);
  return { id: row!.id, email };
}

/** Agência com a dona e uma pessoa convidada no cargo escolhido. */
async function agencyWith(roleName: string) {
  const dona = await user(`dona-${randomUUID()}@exemplo.com`);
  const { id: agencyId } = await createAgency(sql, dona.id, { name: `Agência ${randomUUID().slice(0, 6)}` });
  const roles = await listRoles(sql, agencyId);
  const role = roles.find((r) => r.name === roleName)!;
  const pessoa = await user(`p-${randomUUID()}@exemplo.com`);
  const { token } = await inviteMember(sql, agencyId, { id: dona.id, access: (await memberAccess(sql, agencyId, dona.id))! }, { email: pessoa.email, role_id: role.id });
  await acceptInvite(sql, pessoa, token);
  return { agencyId, dona, pessoa, roles, role };
}

const access = async (agencyId: string, userId: string) => ({ id: userId, ...(await memberAccess(sql, agencyId, userId))! });
/** Mesmo acesso, no formato das funções da equipe. */
const asTeam = (a: Awaited<ReturnType<typeof access>>) => ({ id: a.id, access: a });

test("toda agência nova ganha os cargos prontos, e o convidado entra no cargo escolhido", async () => {
  const { agencyId, pessoa, roles, role } = await agencyWith("Gestor de tráfego");
  assert.deepEqual(roles.map((r) => r.name), ["Administrador", "Gestor de tráfego", "Atendimento", "Financeiro", "Leitor"]);
  const a = (await memberAccess(sql, agencyId, pessoa.id))!;
  assert.equal(a.roleId, role.id);
  assert.equal(a.perms.campanhas, "editar");
  assert.equal(a.perms.financeiro, "nenhum");
});

test("o cargo vale no servidor: ver, editar e sem acesso por área", async () => {
  const { agencyId, pessoa } = await agencyWith("Gestor de tráfego");
  await requireRole(sql, pessoa.id, agencyId, CAN_USE, { area: "campanhas" });
  await requireRole(sql, pessoa.id, agencyId, CAN_READ, { area: "comercial" });
  await assert.rejects(requireRole(sql, pessoa.id, agencyId, CAN_USE, { area: "comercial" }), /só permite ver Vendas/);
  await assert.rejects(requireRole(sql, pessoa.id, agencyId, CAN_READ, { area: "financeiro" }), /não tem acesso a Financeiro/);
  // Sem área: gerir pede editar nas configurações.
  await assert.rejects(requireRole(sql, pessoa.id, agencyId, CAN_MANAGE), /Integrações e configurações/);
});

test("cargo próprio: cria, renomeia, muda permissões e quem está nele muda junto", async () => {
  const { agencyId, dona, pessoa } = await agencyWith("Leitor");
  const owner = await access(agencyId, dona.id);
  const social = await createRole(sql, agencyId, owner, { name: "Social media", perms: { projetos: "editar", clientes: "ver" } });
  assert.equal(social.perms.financeiro, "nenhum", "área não marcada fica sem acesso");
  await assert.rejects(createRole(sql, agencyId, owner, { name: "social MEDIA", perms: {} }), /Já existe/);
  await updateMember(sql, agencyId, asTeam(owner), pessoa.id, { role_id: social.id });
  await requireRole(sql, pessoa.id, agencyId, CAN_USE, { area: "projetos" });
  await updateRole(sql, agencyId, owner, social.id, { name: "Social", perms: { ...social.perms, projetos: "ver" } });
  await assert.rejects(requireRole(sql, pessoa.id, agencyId, CAN_USE, { area: "projetos" }), /só permite ver/);
  assert.equal((await listRoles(sql, agencyId)).find((r) => r.id === social.id)!.members, 1);
});

test("ninguém dá mais acesso do que tem, nem troca o próprio cargo", async () => {
  const { agencyId, dona, pessoa, roles } = await agencyWith("Atendimento");
  const owner = await access(agencyId, dona.id);
  // Atendimento com equipe "editar" para poder convidar, mas sem financeiro.
  const atendimento = roles.find((r) => r.name === "Atendimento")!;
  await updateRole(sql, agencyId, owner, atendimento.id, { perms: { ...atendimento.perms, equipe: "editar" } });
  const me = await access(agencyId, pessoa.id);
  await assert.rejects(createRole(sql, agencyId, me, { name: "Tudo", perms: normalizePerms({ financeiro: "editar" }) }), /mais acesso do que tem/);
  await assert.rejects(updateRole(sql, agencyId, me, atendimento.id, { perms: { ...atendimento.perms, financeiro: "ver" } }), /próprio cargo/);
  const admin = roles.find((r) => r.name === "Administrador")!;
  await assert.rejects(inviteMember(sql, agencyId, asTeam(me), { email: `x-${randomUUID()}@e.com`, role_id: admin.id }), /mais acesso do que tem/);
  await assert.rejects(updateMember(sql, agencyId, asTeam(me), pessoa.id, { role_id: admin.id }), /mais acesso|trocar o seu cargo/);
  await assert.rejects(removeMember(sql, agencyId, asTeam(me), dona.id), /outro dono/);
  // Um cargo menor ela pode dar.
  const leitor = roles.find((r) => r.name === "Leitor")!;
  await inviteMember(sql, agencyId, asTeam(me), { email: `y-${randomUUID()}@e.com`, role_id: leitor.id });
});

test("apagar cargo em uso pede para onde as pessoas vão", async () => {
  const { agencyId, dona, pessoa, role, roles } = await agencyWith("Financeiro");
  const owner = await access(agencyId, dona.id);
  await assert.rejects(deleteRole(sql, agencyId, owner, role.id, null), /1 pessoa usa/);
  const leitor = roles.find((r) => r.name === "Leitor")!;
  await deleteRole(sql, agencyId, owner, role.id, leitor.id);
  assert.equal((await memberAccess(sql, agencyId, pessoa.id))!.roleId, leitor.id);
  assert.ok(!(await listRoles(sql, agencyId)).some((r) => r.id === role.id));
});

test("o portal não manda o que o cargo não vê", async () => {
  const { agencyId, dona, pessoa } = await agencyWith("Gestor de tráfego");
  const doDono = await agencyPortal(sql, agencyId, dona.id);
  assert.equal(doDono.access.owner, true);
  const daPessoa = await agencyPortal(sql, agencyId, pessoa.id);
  assert.equal(daPessoa.access.perms.financeiro, "nenhum");
  assert.deepEqual(daPessoa.invoices, []);
  assert.equal(daPessoa.kpis.mrr, 0);
  const eu = daPessoa.team.find((t) => t.user_id === pessoa.id)!;
  assert.equal(eu.perm, "Gestor de tráfego");
  assert.equal(daPessoa.team.find((t) => t.user_id === dona.id)!.perm, "Proprietário");
});

test("apagar cargo sem ninguém: destino conferido sempre; sem destino, convites em aberto são cancelados", async () => {
  const dona = await user(`dona-${randomUUID()}@exemplo.com`);
  const { id: agencyId } = await createAgency(sql, dona.id, { name: `Agência ${randomUUID().slice(0, 6)}` });
  const roles = await listRoles(sql, agencyId);
  const admin = roles.find((r) => r.name === "Administrador")!;
  // Quem edita a equipe mas tem pouco acesso no resto.
  const rh = await createRole(sql, agencyId, { id: dona.id, ...(await memberAccess(sql, agencyId, dona.id))! }, { name: "RH", perms: { equipe: "editar", clientes: "ver" } });
  const pessoa = await user(`rh-${randomUUID()}@exemplo.com`);
  const t = await inviteMember(sql, agencyId, { id: dona.id, access: (await memberAccess(sql, agencyId, dona.id))! }, { email: pessoa.email, role_id: rh.id });
  await acceptInvite(sql, pessoa, t.token);
  const eu = await access(agencyId, pessoa.id);
  const x = await createRole(sql, agencyId, eu, { name: "Estagiário", perms: { clientes: "ver" } });
  const outro = await user(`alt-${randomUUID()}@exemplo.com`);
  const inv = await inviteMember(sql, agencyId, asTeam(eu), { email: outro.email, role_id: x.id });
  await assert.rejects(deleteRole(sql, agencyId, eu, x.id, admin.id), /mais acesso/);
  // Cargo de outra agência como destino também não vale.
  const dona2 = await user(`d2-${randomUUID()}@exemplo.com`);
  const { id: other } = await createAgency(sql, dona2.id, { name: "Outra" });
  const leitorOutra = (await listRoles(sql, other)).find((r) => r.name === "Leitor")!;
  await assert.rejects(deleteRole(sql, agencyId, eu, x.id, leitorOutra.id), /não encontrado/);
  await deleteRole(sql, agencyId, eu, x.id, null);
  await assert.rejects(acceptInvite(sql, outro, inv.token), /inválido/);
});

test("convite sem cargo não vale e o cargo em uso não some", async () => {
  const { agencyId, dona, role } = await agencyWith("Atendimento");
  const novo = await user(`n-${randomUUID()}@exemplo.com`);
  const inv = await inviteMember(sql, agencyId, { id: dona.id, access: (await memberAccess(sql, agencyId, dona.id))! }, { email: novo.email, role_id: role.id });
  await sql.query(`update invites set role_id = null where agency_id = $1 and lower(email) = $2`, [agencyId, novo.email]);
  await assert.rejects(acceptInvite(sql, novo, inv.token), /cargo deste convite foi apagado/);
  await assert.rejects(sql.query(`delete from agency_roles where id = $1`, [role.id]), /violates foreign key/);
});

test("leitura direta pelo banco segue o cargo: financeiro em nenhum não lê faturas", async () => {
  const { agencyId, pessoa, dona } = await agencyWith("Gestor de tráfego");
  const client = await one<{ id: string }>(sql, `insert into clients (agency_id, name) values ($1, 'Loja') returning id`, [agencyId]);
  await sql.query(`insert into finance_entries (agency_id, client_id, kind, category, description, amount_cents, month) values ($1, $2, 'receita', 'Mensalidade', 'Loja', 100000, '2026-11-01')`, [agencyId, client!.id]);
  const asUser = async (id: string, fn: () => Promise<void>) => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id]);
    await db.query(`set role authenticated`);
    try { await fn(); } finally { await db.query(`reset role`); await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
  };
  await asUser(dona.id, async () => assert.equal((await db.query(`select id from finance_entries`)).rows.length, 1, "a dona lê"));
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [pessoa.id]);
  await db.query(`set role authenticated`);
  try {
    assert.equal((await db.query(`select id from clients`)).rows.length, 1, "clientes: editar");
    assert.equal((await db.query(`select id from finance_entries`)).rows.length, 0, "financeiro: nenhum");
    assert.equal((await db.query(`select id from invoices`)).rows.length, 0);
  } finally {
    await db.query(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
});
