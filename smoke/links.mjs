// Confere as ligações das telas com o servidor: cada chamada SP.api('/api/...', { method }) dos
// modelos em design/ tem de bater com uma rota (src/app/api/**/route.ts) que exporte o método.
import { readdirSync, readFileSync } from "node:fs";

const routes = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (e.name === "route.ts") {
      const src = readFileSync(p, "utf8");
      const methods = [...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b|export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1] || m[2]);
      const path = p.replace("src/app", "").replace("/route.ts", "");
      routes.push({ path, methods, re: new RegExp("^" + path.replace(/\[[^\]]+\]/g, "[^/]+") + "$") });
    }
  }
})("src/app/api");

const files = ["design/project/spherum/agencia_tpl.html", "design/project/spherum/cliente_tpl.html", "design/project/spherum/admin_tpl.html", "design/shared/spherum-api.js", "public/site/index.html"];
const problems = [];
let n = 0;
for (const f of files) {
  let src;
  try { src = readFileSync(f, "utf8"); } catch { continue; }
  // '/api/x/' + id + '/y'  →  /api/x/:p/y ; o método vem do { method: 'X' } logo depois, se houver.
  for (const m of src.matchAll(/(?:SP\.api|fetch|api)\(\s*((?:'[^']*'|"[^"]*"|`[^`]*`|[\w.$]+)(?:\s*\+\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[\w.$()[\]'"]+))*)\s*(?:,\s*\{([^}]{0,200}))?/g)) {
    const expr = m[1];
    if (!/\/api\//.test(expr)) continue;
    let url = expr.replace(/`/g, "'").replace(/\$\{[^}]+\}/g, "§").split(/\s*\+\s*/).map((part) => (/^'[^']*'$|^"[^"]*"$/.test(part) ? part.slice(1, -1) : "§")).join("");
    url = url.replace(/\?.*$/, "").replace(/§+/g, "§");
    if (!url.startsWith("/api/")) continue;
    if (url.endsWith("§") && !/\/§$/.test(url)) url = url.replace(/§$/, ""); // '/api/x?y=' + v
    // O método: o primeiro "method: 'X'" antes da próxima chamada (o endereço pode ter parênteses).
    const after = src.slice(m.index + m[0].length - (m[2] || "").length - 2, m.index + 600).split(/SP\.api\(|\bfetch\(/)[0];
    const method = ((m[2] || "").match(/method:\s*'(\w+)'/) || after.match(/^[^;]*?method:\s*'(\w+)'/) || [])[1] || "GET";
    n++;
    const path = url.replace(/§/g, "X");
    const hit = routes.filter((r) => r.re.test(path));
    if (!hit.length) problems.push(`${f.split("/").pop()}: ${method} ${url} → rota não existe`);
    else if (!hit.some((r) => r.methods.includes(method))) problems.push(`${f.split("/").pop()}: ${method} ${url} → rota existe, mas sem ${method} (tem ${hit.map((r) => r.methods.join("/")).join(" | ")})`);
  }
}
console.log(`${n} chamadas das telas conferidas com ${routes.length} rotas`);
if (problems.length) { console.log([...new Set(problems)].join("\n")); process.exit(1); }
console.log("todas as ligações batem");
