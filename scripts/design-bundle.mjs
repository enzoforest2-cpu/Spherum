#!/usr/bin/env node
// Lê e grava o modelo (template) dos pacotes HTML exportados pelo Claude Design.
//
// Os arquivos de public/ são pacotes do Claude Design: o modelo da página vai como texto JSON
// em <script type="__bundler/template"> (com "</" escrito como "</"). Os modelos legíveis
// ficam em design/project/spherum/*_tpl.html; editamos lá e gravamos no pacote com este script.
//
//   node scripts/design-bundle.mjs extract <pacote.html> <modelo.html>
//   node scripts/design-bundle.mjs inject  <pacote.html> <modelo.html>
//   node scripts/design-bundle.mjs check   <pacote.html> <modelo.html>   (sai com erro se diferentes)
//   node scripts/design-bundle.mjs build   (atualiza o bloco da API em todos os modelos e grava os pacotes)
//
// O bloco entre "// <spherum-api>" e "// </spherum-api>" de cada modelo é copiado de
// design/shared/spherum-api.js (sessão do login e chamadas à API, igual em todas as páginas).
import { readFileSync, writeFileSync } from "node:fs";

const TAG = '<script type="__bundler/template">';

function locate(bundle) {
  const start = bundle.indexOf(TAG);
  if (start < 0) throw new Error("pacote sem __bundler/template");
  const a = start + TAG.length;
  const b = bundle.indexOf("</script>", a);
  return { a, b, raw: bundle.slice(a, b) };
}

const encode = (template) => `\n${JSON.stringify(template).replaceAll("</", "<\\u002F")}\n`;

const PAIRS = [
  ["public/site/index.html", "design/project/spherum/root_tpl.html"],
  ["public/prototipo/agencia.html", "design/project/spherum/agencia_tpl.html"],
  ["public/prototipo/cliente.html", "design/project/spherum/cliente_tpl.html"],
  ["public/prototipo/admin.html", "design/project/spherum/admin_tpl.html"],
];
const SNIPPET = /\/\/ <spherum-api>[\s\S]*?\/\/ <\/spherum-api>\n?/;

const [cmd, bundlePath, templatePath] = process.argv.slice(2);
if (cmd === "build") {
  const api = readFileSync("design/shared/spherum-api.js", "utf8");
  for (const [bundleFile, templateFile] of PAIRS) {
    let template = readFileSync(templateFile, "utf8");
    if (SNIPPET.test(template)) {
      template = template.replace(SNIPPET, () => api.endsWith("\n") ? api : `${api}\n`);
      writeFileSync(templateFile, template);
    }
    const bundle = readFileSync(bundleFile, "utf8");
    const { a, b, raw } = locate(bundle);
    if (JSON.parse(raw) === template) continue;
    const out = bundle.slice(0, a) + encode(template) + bundle.slice(b);
    if (JSON.parse(locate(out).raw) !== template) throw new Error(`${bundleFile}: o modelo não voltou igual`);
    writeFileSync(bundleFile, out);
    console.log(`${bundleFile}: modelo gravado`);
  }
  process.exit(0);
}
if (!cmd || !bundlePath || !templatePath) {
  console.error("uso: design-bundle.mjs extract|inject|check <pacote.html> <modelo.html>");
  process.exit(2);
}
const bundle = readFileSync(bundlePath, "utf8");
const { a, b, raw } = locate(bundle);
const current = JSON.parse(raw);

if (cmd === "extract") {
  writeFileSync(templatePath, current);
} else if (cmd === "inject") {
  const template = readFileSync(templatePath, "utf8");
  if (template.includes("</script") && false) throw new Error("impossível");
  const out = bundle.slice(0, a) + encode(template) + bundle.slice(b);
  // Confere a volta: o pacote novo tem exatamente o modelo do arquivo.
  if (JSON.parse(locate(out).raw) !== template) throw new Error("o modelo não voltou igual");
  writeFileSync(bundlePath, out);
  console.log(`${bundlePath}: modelo gravado (${template.length} caracteres)`);
} else if (cmd === "check") {
  const template = readFileSync(templatePath, "utf8");
  if (current !== template) {
    console.error(`${bundlePath} está diferente de ${templatePath}: rode "inject".`);
    process.exit(1);
  }
} else {
  console.error(`comando desconhecido: ${cmd}`);
  process.exit(2);
}
