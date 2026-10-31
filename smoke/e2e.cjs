// Teste ponta a ponta no navegador: a tela real (public/prototipo) servida pelo app (next start),
// falando com a API e o banco de verdade. Roda depois de smoke/run.mjs (que cria a agência e
// grava smoke/.state.json). Abre cada tela do menu da agência e o admin, e falha com erro de
// JavaScript na página ou resposta 5xx da API.
const { chromium } = require("playwright");
const fs = require("fs");

const st = JSON.parse(fs.readFileSync("smoke/.state.json", "utf8"));
const session = (token) => JSON.stringify({ access_token: token, refresh_token: "smoke", expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: "smoke" } });
const problems = [];

async function open(browser, path, token, agencyId) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([s, ag]) => { localStorage.setItem("spherum.session", s); if (ag) localStorage.setItem("spherum.agency", ag); }, [session(token), agencyId]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${path} JS: ${String(e.message).slice(0, 200)}`));
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) problems.push(`${path} API ${r.status()} ${r.request().method()} ${r.url().replace(st.base, "")}`); });
  await page.goto(st.base + path, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  return page;
}

const textOf = (page) => page.evaluate(() => document.body.innerText);

(async () => {
  const browser = await chromium.launch();

  // Agência: dados de verdade na tela e cada item do menu.
  const ag = await open(browser, "/agencia", st.tokens.dona, st.agencyId);
  const home = await textOf(ag);
  for (const want of ["Agência Smoke"]) if (!home.includes(want)) problems.push(`/agencia: não mostra "${want}"`);
  const groups = ["Clientes", "Vendas", "Tráfego", "Projetos e conteúdo", "Financeiro", "Equipe", "Ferramentas"];
  for (const g of groups) await ag.evaluate((t) => { const el = [...document.querySelectorAll("aside *")].find((e) => e.children.length < 3 && e.textContent.trim() === t); el && el.click(); }, g);
  await ag.waitForTimeout(400);
  const items = await ag.evaluate((skip) => [...new Set([...document.querySelectorAll("aside button, aside a, aside [role=button], aside div")].filter((e) => e.offsetParent && e.children.length < 4).map((e) => e.textContent.trim()).filter((t) => t && t.length < 30 && !skip.includes(t) && !/sair|logout|entrar/i.test(t)))], groups);
  let visited = 0;
  for (const label of items) {
    const clicked = await ag.evaluate((t) => { const el = [...document.querySelectorAll("aside *")].find((e) => e.offsetParent && e.children.length < 4 && e.textContent.trim() === t); if (!el) return false; el.click(); return true; }, label);
    if (!clicked) continue;
    visited++;
    await ag.waitForTimeout(900);
    const body = await textOf(ag);
    if (/Algo deu errado|Cannot read|undefined is not|\[object Object\]|NaN/.test(body)) problems.push(`tela "${label}": texto de erro na página (${(body.match(/Algo deu errado|Cannot read|undefined is not|\[object Object\]|NaN/) || [])[0]})`);
  }
  // Dados criados pela API aparecem nas telas certas (página nova: a varredura mexe no menu).
  const pg = await open(browser, "/agencia", st.tokens.dona, st.agencyId);
  const goTo = async (group, item) => {
    const side = pg.locator("aside");
    const target = side.getByText(item, { exact: true });
    if (group !== item ? !(await target.first().isVisible()) : (await target.count()) < 2) await side.getByText(group, { exact: true }).first().click();
    await pg.waitForTimeout(300);
    await target.last().click();
  };
  for (const [group, item, want] of [["Clientes", "Clientes", "Padaria Sol"], ["Vendas", "CRM", "Academia Força"], ["Projetos e conteúdo", "Projetos", "Lançamento"], ["Vendas", "Prospecção", "Prospecção"]]) {
    await goTo(group, item);
    await pg.waitForTimeout(1200);
    if (!(await textOf(pg)).includes(want)) { problems.push(`${item}: não mostra "${want}" criado pela API`); await pg.screenshot({ path: `smoke/.falha-${item}.png` }); }
  }
  await ag.screenshot({ path: "smoke/.agencia.png" });

  // Portal do cliente: quem foi convidado vê o próprio cliente.
  const cp = await open(browser, "/cliente", st.tokens.portal);
  const cpText = await textOf(cp);
  if (!cpText.includes("Padaria Sol")) { problems.push(`/cliente: não mostra "Padaria Sol"`); await cp.screenshot({ path: "smoke/.falha-cliente.png" }); }

  // Admin com duas etapas.
  const ad = await open(browser, "/admin", st.tokens.staff);
  if (!(await textOf(ad)).includes("Agência Smoke")) problems.push(`/admin: não mostra a "Agência Smoke"`);

  await browser.close();
  console.log(`telas visitadas no menu da agência: ${visited}`);
  if (problems.length) { console.log("PROBLEMAS:\n - " + [...new Set(problems)].join("\n - ")); process.exit(1); }
  console.log("ponta a ponta: tudo certo");
})();
