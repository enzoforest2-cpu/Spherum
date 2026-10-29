import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { importLeads, prospectBoard } from "../src/lib/core/prospect";
import { connectSourceKey, phoneInText, searchCnpj, searchInstagram, searchMaps, sourcesStatus } from "../src/lib/core/prospect-sources";
import { saveConnection, type IntegrationDeps } from "../src/lib/integrations/store";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

const MASTER = "chave-mestra-de-teste-com-mais-de-32-caracteres";
let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const out = handler(url, init);
    const [status, body] = Array.isArray(out) && typeof out[0] === "number" ? (out as [number, unknown]) : [200, out];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

async function agency() {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id } = await createAgency(sql, dona, { name: "Agência Fontes" });
  return { agencyId: id, dona };
}

test("telefone na bio do Instagram: wa.me, número com DDD ou nada", () => {
  assert.equal(phoneInText("Pedidos: wa.me/5541992215850"), "5541992215850");
  assert.equal(phoneInText("📞 (41) 99221-5850 · Curitiba"), "5541992215850");
  assert.equal(phoneInText("Fixo 41 3322-1100"), "554133221100");
  assert.equal(phoneInText("Desde 2019 · 10 mil clientes"), null);
});

test("Google Maps: pede a chave, busca com a chave guardada e marca quem já está na lista", async () => {
  const { agencyId, dona } = await agency();
  const f = fakeFetch((url, init) => {
    assert.ok(url.startsWith("https://places.googleapis.com/v1/places:searchText"));
    const h = new Headers(init.headers);
    if (h.get("x-goog-api-key") !== "AIzaChaveDeTesteValida123") return [403, { error: { message: "API key not valid." } }];
    const body = JSON.parse(String(init.body));
    if (body.pageSize === 1) return { places: [] };
    assert.equal(body.textQuery, "padaria em Campinas");
    return {
      nextPageToken: "pg2",
      places: [
        { id: "a", displayName: { text: "Pão Quente" }, internationalPhoneNumber: "+55 19 99111-2222", websiteUri: "https://pq.com.br", rating: 4.7, userRatingCount: 320, primaryTypeDisplayName: { text: "Padaria" }, formattedAddress: "Rua A, 10" },
        { id: "b", displayName: { text: "Estrela" }, nationalPhoneNumber: "(19) 3222-1111" },
        { id: "c", displayName: { text: "Fechada" }, nationalPhoneNumber: "(19) 99999-0000", businessStatus: "CLOSED_PERMANENTLY" },
        { id: "d", displayName: { text: "Sem fone" } },
      ],
    };
  });
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: f.fn, appUrl: "https://spherum.com.br" };
  await assert.rejects(searchMaps(deps, agencyId, { query: "padaria", city: "Campinas" }), /chave do Google Maps/);
  await assert.rejects(connectSourceKey(deps, agencyId, dona, { source: "maps", key: "AIzaChaveErradaDeTeste1" }), /Google recusou/);
  await connectSourceKey(deps, agencyId, dona, { source: "maps", key: "AIzaChaveDeTesteValida123" });
  assert.equal((await sourcesStatus(sql, agencyId)).maps, true);

  await importLeads(sql, agencyId, dona, { list: "Antiga", consent: true, text: "19991112222" });
  const r = await searchMaps(deps, agencyId, { query: "padaria", city: "Campinas" });
  assert.equal(r.next, "pg2");
  assert.deepEqual(r.items.map((i) => [i.company, i.phone, i.mobile, i.exists]), [
    ["Pão Quente", "5519991112222", true, true],
    ["Estrela", "551932221111", false, false],
    ["Sem fone", null, false, false],
  ]);
  assert.match(r.items[0].info!, /★ 4.7 \(320\)/);

  // Importa com a origem gravada.
  const imp = await importLeads(sql, agencyId, dona, { list: "Padarias", source: "google_maps", consent: true, rows: [{ phone: r.items[1].phone!, company: "Estrela", origin: r.items[1].origin, website: "https://e.com" }] });
  assert.equal(imp.added, 1);
  const lead = (await prospectBoard(sql, agencyId)).leads.find((l) => l.company === "Estrela")!;
  assert.equal(lead.source, "google_maps");
  assert.equal(lead.origin, 'Google Maps: "padaria" em Campinas');
});

test("CNPJ por CNAE: filtros da CNPJá, cidade pelo código do IBGE e celular primeiro", async () => {
  const { agencyId, dona } = await agency();
  let last = "";
  const f = fakeFetch((url, init) => {
    if (url.includes("servicodados.ibge.gov.br")) return [{ id: 3509502, nome: "Campinas" }, { id: 3550308, nome: "São Paulo" }];
    assert.equal(new Headers(init.headers).get("authorization"), "cnpja-chave-de-teste-123");
    last = url;
    if (url.includes("limit=1")) return { records: [] };
    return {
      next: null,
      records: [{
        taxId: "12345678000190", alias: "Academia Forte", company: { name: "FORTE FITNESS LTDA" }, address: { city: "Campinas", district: "Centro" }, founded: "2015-03-01",
        phones: [{ type: "LANDLINE", area: "19", number: "32221111" }, { type: "MOBILE", area: "19", number: "991234567" }], emails: [{ address: "contabil@x.com", ownership: "ACCOUNTING" }, { address: "oi@forte.com", ownership: "CORPORATE" }],
        mainActivity: { id: 9313100, text: "Atividades de condicionamento físico" },
      }],
    };
  });
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: f.fn, appUrl: "https://spherum.com.br" };
  await connectSourceKey(deps, agencyId, dona, { source: "cnpj", key: "cnpja-chave-de-teste-123" });
  await assert.rejects(searchCnpj(deps, agencyId, { cnae: ["9313100"], uf: "SP", city: "Campinass" }), /Não achei a cidade/);
  const r = await searchCnpj(deps, agencyId, { cnae: ["9313100"], uf: "SP", city: "campinas" });
  const q = new URL(last).searchParams;
  assert.equal(q.get("mainActivity.id.in"), "9313100");
  assert.equal(q.get("address.municipality.in"), "3509502");
  assert.equal(q.get("status.id.in"), "2");
  assert.equal(q.get("phones.type.in"), "MOBILE");
  assert.equal(r.items[0].phone, "5519991234567");
  assert.equal(r.items[0].email, "oi@forte.com");
  assert.equal(r.items[0].company, "Academia Forte");
  assert.match(r.items[0].origin, /CNPJ 12\.345\.678\/0001-90/);
});

test("Instagram: Business Discovery pela conta da Meta; perfil pessoal fica em 'missing'", async () => {
  const { agencyId } = await agency();
  const f = fakeFetch((url) => {
    if (url.includes("/me/accounts")) return { data: [{ instagram_business_account: { id: "17841400000" } }] };
    if (url.includes("padariasol")) return { business_discovery: { username: "padariasol", name: "Padaria Sol", biography: "Encomendas wa.me/5541992215850", website: "https://sol.com", followers_count: 5400 } };
    return [400, { error: { message: "Invalid user id" } }];
  });
  const deps: IntegrationDeps = { sql, masterKey: MASTER, fetch: f.fn, appUrl: "https://spherum.com.br" };
  await assert.rejects(searchInstagram(deps, agencyId, { usernames: ["@padariasol"] }), /Conecte a Meta/);
  await saveConnection(deps, { agencyId, provider: "meta", label: "Meta", account: "meta-1", secret: { accessToken: "tok" } });
  const r = await searchInstagram(deps, agencyId, { usernames: ["@padariasol", "fulano.pessoal"] });
  assert.deepEqual(r.missing, ["fulano.pessoal"]);
  assert.equal(r.items[0].phone, "5541992215850");
  assert.match(r.items[0].info!, /5\.400 seguidores/);
});
