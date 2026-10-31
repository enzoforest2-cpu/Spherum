import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { brandForHost, brandOf, checkDomain, logoOf, removeDomain, setBrand, setDomain, setLogo } from "../src/lib/core/brand";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

async function agency(plan = "escala", status = "active") {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id } = await createAgency(sql, dona, { name: "Lumen" });
  await sql.query(`update agencies set plan = $2, plan_status = $3 where id = $1`, [id, plan, status]);
  return { id, dona };
}

const ENV = { token: "tok", projectId: "prj_1", teamId: "team_1" };
function vercel(verified: boolean, misconfigured: boolean) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(`${init.method ?? "GET"} ${url.replace("https://api.vercel.com", "")}`);
    const body = url.includes("/config") ? { misconfigured } : { name: url.includes("spherum.com.br") ? "lumen.spherum.com.br" : "portal.lumen.com.br", verified, verification: verified ? [] : [{ type: "TXT", domain: "_vercel.lumen.com.br", value: "vc-domain-verify=abc" }] };
    return new Response(JSON.stringify(init.method === "DELETE" ? {} : body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

test("marca no servidor: o plano decide o que vale", async () => {
  const solo = await agency("solo");
  await assert.rejects(setBrand(sql, solo.id, solo.dona, { on_client: true }), /plano Agência/);
  assert.equal((await brandOf(sql, solo.id)).on_client, false, "Solo não tem marca no portal");
  const ag = await agency("agencia");
  await assert.rejects(setBrand(sql, ag.id, ag.dona, { powered: false }), /Escala/);
  const b = await setBrand(sql, ag.id, ag.dona, { name: "Lumen Agência", on_client: true });
  assert.equal(b.name, "Lumen Agência");
  assert.equal(b.powered, true);
  await assert.rejects(setLogo(sql, ag.id, ag.dona, { logo: "data:text/html;base64,PHNjcmlwdD4=" }), /PNG, JPG/);
  const png = "data:image/png;base64," + Buffer.from("png").toString("base64");
  const withLogo = await setLogo(sql, ag.id, ag.dona, { logo: png });
  assert.match(withLogo.logo_url!, new RegExp(`^/api/public/logo/${ag.id}\\?v=\\d+$`));
  assert.equal((await logoOf(sql, ag.id))!.type, "image/png");
});

test("domínio próprio: Escala cadastra na Vercel, mostra o DNS e fica ativo quando aponta certo", async () => {
  const ag = await agency("agencia");
  await assert.rejects(setDomain(sql, vercel(false, true).fn, ENV, ag.id, ag.dona, { domain: "portal.lumen.com.br" }), /Escala/);
  await assert.rejects(setDomain(sql, vercel(false, true).fn, ENV, ag.id, ag.dona, { domain: "x.spherum.com.br" }), /domínio da sua agência/);
  // No Agência, o add-on "Portal no seu próprio domínio" libera.
  const comAddon = await agency("agencia");
  await sql.query(`insert into agency_addons (agency_id, addon_id, qty) values ($1, 'domain', 1)`, [comAddon.id]);
  assert.equal((await setDomain(sql, vercel(false, true).fn, ENV, comAddon.id, comAddon.dona, { domain: "portal.addon.com.br" }))!.domain, "portal.addon.com.br");
  const esc = await agency("escala");
  const v1 = vercel(false, true);
  const d = await setDomain(sql, v1.fn, ENV, esc.id, esc.dona, { domain: "https://Portal.Lumen.com.br/" });
  assert.equal(d!.domain, "portal.lumen.com.br");
  assert.equal(d!.status, "pendente");
  assert.deepEqual((d!.records as { type: string }[]).map((r) => r.type), ["CNAME", "TXT"]);
  assert.ok(v1.calls[0].startsWith("POST /v10/projects/prj_1/domains?teamId=team_1"));
  assert.equal(await brandForHost(sql, "portal.lumen.com.br"), null, "pendente não abre o portal");
  const ok = await checkDomain(sql, vercel(true, false).fn, ENV, esc.id);
  assert.equal(ok!.status, "ativo");
  assert.equal((await brandForHost(sql, "PORTAL.lumen.com.br:443"))!.agency_id, esc.id);
  // Outra agência não pega o mesmo domínio.
  const outra = await agency("rede");
  await assert.rejects(setDomain(sql, vercel(true, false).fn, ENV, outra.id, outra.dona, { domain: "portal.lumen.com.br" }), /em uso/);
  await removeDomain(sql, vercel(true, false).fn, ENV, esc.id, esc.dona);
  assert.equal(await brandForHost(sql, "portal.lumen.com.br"), null);
});

test("subdomínio do Spherum no plano Agência, sem DNS para a agência; nomes reservados recusados", async () => {
  const ag = await agency("agencia");
  await assert.rejects(setDomain(sql, vercel(true, false).fn, ENV, ag.id, ag.dona, { sub: "admin" }), /reservado/);
  const d = await setDomain(sql, vercel(true, false).fn, ENV, ag.id, ag.dona, { sub: "lumen" });
  assert.equal(d!.domain, "lumen.spherum.com.br");
  assert.deepEqual(d!.records, []);
  assert.equal(d!.status, "ativo");
  await assert.rejects(setDomain(sql, vercel(true, false).fn, { token: "", projectId: "" }, ag.id, ag.dona, { sub: "outro" }), /configuração da Vercel/);
});
