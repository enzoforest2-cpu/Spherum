// Monta a tela: junta o JavaScript (React + telas) e o CSS em ui/, e copia as fontes.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "ui");
mkdirSync(path.join(out, "fonts"), { recursive: true });

await build({
  entryPoints: [path.join(root, "ui-src/main.jsx")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(out, "app.js"),
  logLevel: "warning",
});

const css = readFileSync(path.join(root, "ui-src/bots.css"), "utf8") + "\n" + readFileSync(path.join(root, "ui-src/style.css"), "utf8");
writeFileSync(path.join(out, "app.css"), css);

for (const w of [500, 600]) {
  copyFileSync(path.join(root, `node_modules/@fontsource/fredoka/files/fredoka-latin-${w}-normal.woff2`), path.join(out, `fonts/fredoka-${w}.woff2`));
}

writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Xodós</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<div id="app"></div>
</body>
</html>
`,
);
console.log("Tela pronta em ui/");
