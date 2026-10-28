import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { FILE_TOOLS, setFilesRoot, TRASH } from "../src/local/files";
import { htmlToText, parseDuckResults, setWebDeps, WEB_TOOLS } from "../src/local/web";
import { ToolError } from "../src/xodos/tool-error";
import type { ToolContext, ToolDef } from "../src/xodos/tools";

let ROOT: string;
const ctx = {} as ToolContext;
const byName = (list: ToolDef[], name: string) => list.find((t) => t.name === name)!;
const run = (list: ToolDef[], name: string, input: unknown) => {
  const t = byName(list, name);
  return t.execute(ctx, t.input.parse(input));
};

before(async () => {
  ROOT = mkdtempSync(path.join(tmpdir(), "xodos-arquivos-"));
  await setFilesRoot(ROOT);
});

test("pasta: escreve, lista e lê dentro da pasta dos xodós", async () => {
  await run(FILE_TOOLS, "escrever_arquivo", { caminho: "resumos/hoje.md", conteudo: "# Hoje\nTudo certo." });
  const list = (await run(FILE_TOOLS, "listar_arquivos", { pasta: "resumos" })) as { itens: { nome: string }[] };
  assert.deepEqual(list.itens.map((i) => i.nome), ["hoje.md"]);
  const read = (await run(FILE_TOOLS, "ler_arquivo", { caminho: "resumos/hoje.md" })) as { texto: string };
  assert.equal(read.texto, "# Hoje\nTudo certo.");
  // Não sobrescreve sem pedir.
  await assert.rejects(run(FILE_TOOLS, "escrever_arquivo", { caminho: "resumos/hoje.md", conteudo: "x" }), /já existe/);
  await run(FILE_TOOLS, "escrever_arquivo", { caminho: "resumos/hoje.md", conteudo: "novo", substituir: true });
  assert.equal(readFileSync(path.join(ROOT, "resumos/hoje.md"), "utf8"), "novo");
});

test("pasta: nada sai dela, nem por .., caminho absoluto, letra de disco ou atalho", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "fora-"));
  writeFileSync(path.join(outside, "segredo.txt"), "senha");
  symlinkSync(outside, path.join(ROOT, "atalho"));
  for (const caminho of ["../segredo.txt", "resumos/../../x.txt", path.join(outside, "segredo.txt"), "C:\\Windows\\win.ini", "atalho/segredo.txt"]) {
    await assert.rejects(run(FILE_TOOLS, "ler_arquivo", { caminho }), ToolError, caminho);
  }
  await assert.rejects(run(FILE_TOOLS, "escrever_arquivo", { caminho: "atalho/novo.txt", conteudo: "x" }), ToolError);
  assert.ok(!existsSync(path.join(outside, "novo.txt")));
  await assert.rejects(run(FILE_TOOLS, "listar_arquivos", { pasta: ".." }), ToolError);
});

test("pasta: só escreve e lê texto", async () => {
  await assert.rejects(run(FILE_TOOLS, "escrever_arquivo", { caminho: "programa.exe", conteudo: "x" }), /extensão de texto/);
  writeFileSync(path.join(ROOT, "foto.png"), "x");
  await assert.rejects(run(FILE_TOOLS, "ler_arquivo", { caminho: "foto.png" }), /Ainda não sei ler/);
});

test("pasta: apagar move para a lixeira dos xodós", async () => {
  mkdirSync(path.join(ROOT, "velhos"), { recursive: true });
  writeFileSync(path.join(ROOT, "velhos/a.txt"), "a");
  const r = (await run(FILE_TOOLS, "apagar_arquivo", { caminho: "velhos/a.txt" })) as { movido_para: string };
  assert.ok(!existsSync(path.join(ROOT, "velhos/a.txt")));
  assert.ok(r.movido_para.startsWith(`${TRASH}/`));
  assert.equal(readFileSync(path.join(ROOT, r.movido_para), "utf8"), "a");
  await assert.rejects(run(FILE_TOOLS, "apagar_arquivo", { caminho: "." }), /pasta principal/);
});

test("web: texto da página sem scripts, menus e entidades", () => {
  const { title, text } = htmlToText(
    `<html><head><title>Preço &amp; prazo</title><script>alert(1)</script></head><body><nav>Menu</nav><main><h1>Geladeira</h1><p>Custa R$&nbsp;3.499</p><ul><li>Frost free</li></ul></main><footer>Rodapé</footer></body></html>`,
  );
  assert.equal(title, "Preço & prazo");
  assert.match(text, /## Geladeira/);
  assert.match(text, /Custa R\$ 3\.499/);
  assert.match(text, /• Frost free/);
  assert.doesNotMatch(text, /alert|Menu|Rodapé/);
});

test("web: resultados do buscador com o endereço de verdade", () => {
  const html = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com.br%2Fpreco&amp;rut=x">Preço da <b>geladeira</b></a>
  <a class="result__snippet" href="#">A partir de <b>R$ 3.499</b> em 10x</a></div>`;
  assert.deepEqual(parseDuckResults(html, 5), [{ titulo: "Preço da geladeira", url: "https://exemplo.com.br/preco", resumo: "A partir de R$ 3.499 em 10x" }]);
});

test("web: não abre endereços da rede de casa nem do próprio computador", async () => {
  setWebDeps({ resolve: async () => [{ address: "192.168.0.1" }], fetch: (async () => new Response("roteador")) as typeof fetch });
  await assert.rejects(run(WEB_TOOLS, "ler_pagina", { url: "http://roteador.example.com" }), /rede privada/);
  await assert.rejects(run(WEB_TOOLS, "ler_pagina", { url: "http://localhost:8080" }), ToolError);
  // Redirecionamento para a rede interna também é barrado.
  let calls = 0;
  setWebDeps({
    resolve: async (h) => [{ address: h === "interno.example.com" ? "10.0.0.5" : "93.184.216.34" }],
    fetch: (async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://interno.example.com/admin" } }); }) as typeof fetch,
  });
  await assert.rejects(run(WEB_TOOLS, "ler_pagina", { url: "https://publico.example.com" }), /rede privada/);
  assert.equal(calls, 1);
  setWebDeps({});
});

test("web: página longa vem em partes", async () => {
  const body = `<html><body><main>${"<p>linha de texto</p>".repeat(2000)}</main></body></html>`;
  setWebDeps({ resolve: async () => [{ address: "93.184.216.34" }], fetch: (async () => new Response(body, { headers: { "content-type": "text/html" } })) as typeof fetch });
  const first = (await run(WEB_TOOLS, "ler_pagina", { url: "https://exemplo.com" })) as { texto: string; continua?: string };
  assert.equal(first.texto.length, 12_000);
  assert.match(first.continua!, /a_partir_de = 12000/);
  setWebDeps({});
});
