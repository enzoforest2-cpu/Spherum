// Teste smoke do Spherum: o app de verdade (next start), um Postgres de verdade e o login
// simulado (smoke/fake-auth.mjs). Passa pelos fluxos principais como dono da agência, equipe do
// Spherum, cliente e API pública, e varre todas as rotas GET procurando erro 5xx.
//
//   SMOKE_PG=postgres://postgres@127.0.0.1:5499 SMOKE_BASE=http://127.0.0.1:3100 node smoke/run.mjs
//
// Só prepara o banco (sem chamar o app): node smoke/run.mjs --setup
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const PG = process.env.SMOKE_PG || "postgres://postgres@127.0.0.1:5499";
const DB = process.env.SMOKE_DB || "smoke_app";
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:3100";
const CRON_SECRET = process.env.CRON_SECRET || "smoke-cron-secret";

const users = {
  dona: { sub: randomUUID(), email: "dona@smoke.test", meta: { full_name: "Dona Smoke" } },
  ana: { sub: randomUUID(), email: "ana@smoke.test", meta: { full_name: "Ana Equipe" } },
  staff: { sub: randomUUID(), email: "staff@spherum.test", meta: { full_name: "Equipe Spherum" } },
  cliente: { sub: randomUUID(), email: "cliente@smoke.test", meta: { full_name: "Cliente Smoke" } },
  portal: { sub: randomUUID(), email: "ze@padaria.test", meta: { full_name: "Seu Zé" } },
};
const tokenOf = (u, aal = "aal1") =>
  `x.${Buffer.from(JSON.stringify({ sub: u.sub, email: u.email, meta: u.meta, aal })).toString("base64url")}.y`;

async function setup() {
  const root = postgres(`${PG}/postgres`, { max: 1, onnotice: () => {} });
  await root.unsafe(`drop database if exists ${DB} with (force)`);
  await root.unsafe(`create database ${DB}`);
  await root.end();
  const sql = postgres(`${PG}/${DB}`, { max: 1, onnotice: () => {} });
  await sql.unsafe(readFileSync("tests/fixtures/foundation.sql", "utf8"));
  for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(`supabase/migrations/${f}`, "utf8"));
  }
  for (const u of Object.values(users)) {
    await sql`insert into auth.users (id, email, raw_user_meta_data) values (${u.sub}, ${u.email}, ${sql.json(u.meta)})`;
  }
  await sql`insert into spherum_staff (user_id, role) values (${users.staff.sub}, 'dono')`;
  await sql.end();
}

// ---------------------------------------------------------------------------

const results = [];
let failures = 0;
async function call(method, path, { as, aal, body, headers = {}, expect } = {}) {
  const h = { ...headers };
  if (as) h.authorization = `Bearer ${tokenOf(users[as], aal)}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const t0 = Date.now();
  let status = 0, data = null, text = "";
  try {
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(60_000) });
    status = r.status;
    text = await r.text();
    try { data = JSON.parse(text); } catch { data = null; }
  } catch (e) {
    text = String(e?.message || e);
  }
  const ms = Date.now() - t0;
  const ok = expect ? [].concat(expect).includes(status) : status > 0 && status < 500;
  if (!ok) failures++;
  results.push({ method, path, status, ms, ok, err: ok ? "" : (data?.error || text).slice(0, 200) });
  return { status, data, text, ok };
}
const step = (name) => console.log(`\n## ${name}`);

async function run() {
  step("Saúde e páginas");
  await call("GET", "/api/saude", { expect: 200 });
  for (const p of ["/", "/agencia", "/cliente", "/admin", "/status"]) await call("GET", p, { expect: 200 });
  await call("GET", "/api/public/status", { expect: 200 });
  await call("GET", "/api/public/manifest", { expect: 200 });
  await call("GET", "/api/public/brand", { expect: [200, 404] });

  step("Login e agência");
  await call("GET", "/api/me", { expect: 401 });
  const ag = await call("POST", "/api/agencies", { as: "dona", body: { name: "Agência Smoke", state: "SP", plan: "escala" }, expect: 201 });
  const agencyId = ag.data?.agency?.id;
  if (!agencyId) throw new Error("não criou a agência: " + ag.text.slice(0, 300));
  await call("GET", "/api/me", { as: "dona", expect: 200 });
  const portal = await call("GET", `/api/portal/agencia?agency_id=${agencyId}`, { as: "dona", expect: 200 });
  await call("GET", `/api/portal/xodos?agency_id=${agencyId}`, { as: "dona", expect: 200 });
  await call("GET", `/api/portal/agencia?agency_id=${agencyId}`, { as: "ana", expect: [403, 404] });

  step("Clientes, CRM, projetos e financeiro");
  const cl = await call("POST", "/api/clients", { as: "dona", body: { agency_id: agencyId, name: "Padaria Sol", segment: "Padaria", monthly_fee: 2500 }, expect: 201 });
  const clientId = cl.data?.client?.id;
  await call("GET", `/api/clients?agency_id=${agencyId}`, { as: "dona", expect: 200 });
  if (clientId) {
    await call("PATCH", `/api/clients/${clientId}`, { as: "dona", body: { agency_id: agencyId, segment: "Panificadora" }, expect: 200 });
    await call("POST", `/api/clients/${clientId}/contacts`, { as: "dona", body: { agency_id: agencyId, name: "Seu Zé", email: "ze@padaria.test" }, expect: [200, 201] });
  }
  const deal = await call("POST", "/api/deals", { as: "dona", body: { agency_id: agencyId, company: "Academia Força", value: 4000 }, expect: 201 });
  if (deal.data?.deal?.id) await call("PATCH", `/api/deals/${deal.data.deal.id}`, { as: "dona", body: { agency_id: agencyId, stage: "proposta" }, expect: 200 });
  const proj = await call("POST", "/api/projects", { as: "dona", body: { agency_id: agencyId, name: "Lançamento", client_id: clientId, due_date: "2026-12-15" }, expect: [200, 201] });
  const projectId = proj.data?.project?.id;
  if (projectId) await call("POST", `/api/projects/${projectId}/tasks`, { as: "dona", body: { agency_id: agencyId, title: "Criar artes" }, expect: [200, 201] });
  await call("POST", "/api/finance/entries", { as: "dona", body: { agency_id: agencyId, kind: "fixa", category: "Ferramentas", description: "Assinaturas", amount: 300, month: "2026-11" }, expect: [200, 201] });

  step("Prospecção");
  await call("POST", "/api/prospect/leads", { as: "dona", body: { agency_id: agencyId, list: "Evento", consent: true, text: "(11) 99999-0001, Ana\n11999990002, Beto" }, expect: [200, 201] });
  await call("PATCH", "/api/prospect", { as: "dona", body: { agency_id: agencyId, daily_limit: 60 }, expect: 200 });
  await call("GET", `/api/prospect?agency_id=${agencyId}`, { as: "dona", expect: 200 });

  step("Equipe e convites");
  const inv = await call("POST", `/api/agencies/${agencyId}/invites`, { as: "dona", body: { email: users.ana.email, role: "member" }, expect: [200, 201] });
  const tokenFrom = (r) => r.data?.invite?.token || r.data?.token || (String(r.data?.link || "").match(/[?&#](?:convite|token|invite)=([^&#]+)/) || [])[1] || String(r.data?.link || "").split("/").pop();
  const invToken = tokenFrom(inv);
  await call("POST", "/api/invites/accept", { as: "ana", body: { token: invToken || "sem-token" }, expect: [200, 201] });
  const team = await call("GET", `/api/agencies/${agencyId}/members`, { as: "dona", expect: 200 });
  if (!JSON.stringify(team.data).includes(users.ana.email)) { failures++; console.log("  FALHA: Ana aceitou o convite mas não aparece na equipe"); }

  step("Portal do cliente");
  if (clientId) {
    const pinv = await call("POST", `/api/clients/${clientId}/portal`, { as: "dona", body: { email: users.portal.email }, expect: 201 });
    await call("POST", "/api/invites/accept", { as: "portal", body: { token: tokenFrom(pinv) || "sem-token" }, expect: [200, 201] });
    const cp = await call("GET", `/api/portal/cliente?client_id=${clientId}`, { as: "portal", expect: 200 });
    if (!JSON.stringify(cp.data || {}).includes("Padaria Sol")) { failures++; console.log("  FALHA: portal do cliente não mostra o cliente"); }
    await call("GET", `/api/portal/agencia?agency_id=${agencyId}`, { as: "portal", expect: [403, 404] });
    await call("GET", `/api/clients?agency_id=${agencyId}`, { as: "portal", expect: [403, 404] });
  }
  await call("GET", `/api/agencies/${agencyId}/members`, { as: "dona", expect: 200 });

  step("Marca e notificações");
  await call("PATCH", `/api/agencies/${agencyId}/brand`, { as: "dona", body: { color: "#E4572E", name: "Smoke Digital" }, expect: 200 });
  await call("GET", `/api/agencies/${agencyId}/brand`, { as: "dona", expect: 200 });
  const notes = await call("GET", `/api/notifications?agency_id=${agencyId}`, { as: "dona", expect: 200 });
  const firstId = (notes.data?.notifications || notes.data?.items || [])[0]?.id;
  await call("POST", "/api/notifications", { as: "dona", body: { agency_id: agencyId, ids: firstId ? [firstId] : [] }, expect: [200, 204] });

  step("API pública");
  await call("PATCH", `/api/admin/agencies/${agencyId}`, { as: "staff", aal: "aal2", body: { plan: "rede", plan_status: "active" }, expect: 200 });
  const key = await call("POST", `/api/agencies/${agencyId}/api-keys`, { as: "dona", body: { name: "Smoke", scopes: ["read", "write"] }, expect: 201 });
  const apiKey = key.data?.key?.key;
  if (apiKey) {
    const auth = { authorization: `Bearer ${apiKey}` };
    await call("GET", "/api/v1/clients", { headers: auth, expect: 200 });
    if (clientId) await call("GET", `/api/v1/clients/${clientId}/metrics`, { headers: auth, expect: 200 });
    await call("POST", "/api/v1/deals", { headers: auth, body: { company: "Via API" }, expect: 201 });
    await call("GET", "/api/v1/deals", { headers: auth, expect: 200 });
  }
  await call("GET", "/api/v1/clients", { headers: { authorization: "Bearer sph_live_invalida" }, expect: 401 });

  step("Admin do Spherum");
  await call("GET", "/api/admin", { as: "staff", aal: "aal1", expect: 403 });
  await call("GET", "/api/admin", { as: "staff", aal: "aal2", expect: 200 });
  await call("GET", "/api/admin", { as: "dona", aal: "aal2", expect: 404 });
  await call("GET", `/api/admin/agencies/${agencyId}/view`, { as: "staff", aal: "aal2", expect: 200 });

  step("Agendador");
  await call("GET", "/api/cron/xodos", { expect: 401 });
  const cron = await call("GET", "/api/cron/xodos", { headers: { authorization: `Bearer ${CRON_SECRET}` }, expect: 200 });
  if (cron.data) {
    const failed = Object.entries(cron.data).filter(([, v]) => typeof v === "string" && v.startsWith("falhou")).map(([k, v]) => `${k}: ${v.slice(0, 120)}`);
    if (failed.length) console.log("  etapas do agendador com falha:\n   - " + failed.join("\n   - "));
  }
  await call("GET", "/api/saude", { expect: 200 });

  step("Isolamento entre agências");
  const other = await call("POST", "/api/agencies", { as: "cliente", body: { name: "Outra Agência" }, expect: 201 });
  const otherId = other.data?.agency?.id;
  const deny = [401, 403, 404];
  await call("GET", `/api/clients?agency_id=${agencyId}`, { as: "cliente", expect: deny });
  await call("GET", `/api/portal/agencia?agency_id=${agencyId}`, { as: "cliente", expect: deny });
  await call("GET", `/api/agencies/${agencyId}/members`, { as: "cliente", expect: deny });
  await call("GET", `/api/agencies/${agencyId}/api-keys`, { as: "cliente", expect: deny });
  if (otherId && clientId) {
    // Com a própria agência no parâmetro, mas o id de um registro da outra.
    await call("GET", `/api/clients/${clientId}?agency_id=${otherId}`, { as: "cliente", expect: deny });
    await call("PATCH", `/api/clients/${clientId}`, { as: "cliente", body: { agency_id: otherId, name: "Roubado" }, expect: deny });
    await call("DELETE", `/api/clients/${clientId}?agency_id=${otherId}`, { as: "cliente", expect: [...deny, 405] });
    if (deal.data?.deal?.id) await call("PATCH", `/api/deals/${deal.data.deal.id}`, { as: "cliente", body: { agency_id: otherId, stage: "ganho" }, expect: deny });
    if (projectId) await call("POST", `/api/projects/${projectId}/tasks`, { as: "cliente", body: { agency_id: otherId, title: "x" }, expect: deny });
    await call("POST", "/api/projects", { as: "cliente", body: { agency_id: otherId, name: "Com cliente alheio", client_id: clientId, due_date: "2026-12-01" }, expect: [400, 403, 404] });
  }
  if (apiKey && otherId) {
    const auth = { authorization: `Bearer ${apiKey}` };
    const mine = await call("GET", `/api/v1/clients/${clientId}`, { headers: auth, expect: 200 });
    void mine;
    const oc = await call("POST", "/api/clients", { as: "cliente", body: { agency_id: otherId, name: "Cliente da outra" }, expect: 201 });
    if (oc.data?.client?.id) await call("GET", `/api/v1/clients/${oc.data.client.id}`, { headers: auth, expect: 404 });
  }
  const check = await call("GET", `/api/clients?agency_id=${agencyId}`, { as: "dona", expect: 200 });
  if (!(check.data?.clients || []).some((c) => c.name === "Padaria Sol")) { failures++; console.log("  FALHA: cliente da agência foi alterado por outra agência"); }

  step("Carga: 60 pedidos ao mesmo tempo");
  const t0 = Date.now();
  const burst = await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(`${BASE}${i % 2 ? `/api/portal/agencia?agency_id=${agencyId}` : `/api/clients?agency_id=${agencyId}`}`, { headers: { authorization: `Bearer ${tokenOf(users.dona)}` } }).then((r) => r.status).catch(() => 0)));
  const bad = burst.filter((x) => x !== 200).length;
  console.log(`  60 pedidos em ${Date.now() - t0} ms, ${bad} com erro`);
  results.push({ method: "GET", path: "carga 60x portal/clientes", status: bad ? 500 : 200, ms: Date.now() - t0, ok: !bad, err: bad ? `${bad} falharam: ${[...new Set(burst)].join(",")}` : "" });
  if (bad) failures++;

  step("Varredura: todas as rotas GET");
  const ids = { id: agencyId, clientId, projectId, agencyId };
  const routes = walk("src/app/api").filter((r) => /export async function GET/.test(readFileSync(r.file, "utf8")));
  for (const r of routes) {
    if (r.path.startsWith("/api/cron") || r.path.startsWith("/api/v1") || r.path.includes("/callback")) continue;
    let path = r.path;
    if (/\[(?!id\])[^\]]+\]/.test(path.replace(/^\/api\/(agencies|clients)\/\[id\]/, ""))) continue; // outros parâmetros
    if (path.startsWith("/api/agencies/[id]")) path = path.replace("[id]", agencyId);
    else if (path.startsWith("/api/clients/[id]") && clientId) path = path.replace("[id]", clientId);
    else if (path.startsWith("/api/projects/[id]") && projectId) path = path.replace("[id]", projectId);
    else if (path.includes("[")) continue;
    const as = path.startsWith("/api/admin") ? "staff" : path.startsWith("/api/public") ? undefined : "dona";
    await call("GET", `${path}${path.includes("?") ? "&" : "?"}agency_id=${agencyId}${clientId ? `&client_id=${clientId}` : ""}`, { as, aal: "aal2" });
  }
  void ids; void portal;
  // Para o teste no navegador (smoke/e2e.cjs): quem é quem e a agência criada.
  writeFileSync("smoke/.state.json", JSON.stringify({ base: BASE, agencyId, clientId, tokens: { dona: tokenOf(users.dona), staff: tokenOf(users.staff, "aal2"), ana: tokenOf(users.ana), portal: tokenOf(users.portal) } }));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push({ file: p, path: p.replace("src/app", "").replace("/route.ts", "") });
  }
  return out;
}

if (process.argv.includes("--setup")) {
  await setup();
  console.log(`banco ${DB} pronto`);
} else {
  await setup();
  try {
    await run();
  } catch (e) {
    failures++;
    console.error("PAROU:", e.message);
  }
  for (const r of results) console.log(`${r.ok ? "ok  " : "FALHA"} ${String(r.status).padStart(3)} ${String(r.ms).padStart(5)}ms ${r.method} ${r.path}${r.err ? "  → " + r.err : ""}`);
  const slow = results.filter((r) => r.ms > 3000);
  console.log(`\n${results.length} chamadas, ${failures} falhas, ${slow.length} lentas (> 3 s)`);
  process.exit(failures ? 1 : 0);
}
