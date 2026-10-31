import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolError } from "../xodos/tool-error";
import type { ToolDef } from "../xodos/tools";

/**
 * A pasta dos xodós: o único lugar do seu computador onde eles leem e escrevem arquivos.
 * Fora dela não enxergam nada. Apagar não apaga: move para a subpasta "Lixeira dos Xodós",
 * de onde você pode recuperar.
 */

let ROOT: string | null = null;
export const TRASH = "Lixeira dos Xodós";
const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".html", ".htm", ".xml", ".log", ".tsv", ".yaml", ".yml", ".ics", ".srt"]);
const MAX_READ = 200_000;
const MAX_CHARS = 20_000;

export async function setFilesRoot(dir: string) {
  await mkdir(dir, { recursive: true });
  ROOT = await realpath(dir);
}
export const filesRoot = () => ROOT;

/** Caminho dentro da pasta dos xodós, recusando "..", caminhos absolutos e atalhos para fora. */
export async function inside(rel: string, mustExist: boolean): Promise<string> {
  if (!ROOT) throw new ToolError("A pasta dos xodós não está configurada.");
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) throw new ToolError("Use um caminho dentro da pasta dos xodós, como relatorios/maio.md.");
  const full = path.resolve(ROOT, clean || ".");
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new ToolError("Esse caminho sai da pasta dos xodós.");
  try {
    const real = await realpath(full);
    if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new ToolError("Esse caminho sai da pasta dos xodós.");
    return real;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (mustExist) throw new ToolError(`Não encontrei "${clean}".`);
    // Ainda não existe: confere a pasta de cima.
    const parent = path.dirname(full);
    if (parent !== ROOT) await inside(path.relative(ROOT, parent), false);
    return full;
  }
}

const rel = (full: string) => path.relative(ROOT!, full).split(path.sep).join("/") || ".";

function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

const caminho = z.string().max(400);

export const FILE_TOOLS: ToolDef[] = [
  tool({
    name: "listar_arquivos",
    description: "Lista o que há na pasta dos xodós (ou numa subpasta dela): nome, tipo, tamanho e data.",
    category: "leitura",
    input: z.object({ pasta: caminho.default("").describe("Subpasta, ex.: relatorios. Vazio = a pasta principal.") }),
    summarize: (i) => `ver a pasta ${i.pasta || "dos xodós"}`,
    async execute(_ctx, i) {
      const dir = await inside(i.pasta, true);
      const st = await stat(dir);
      if (!st.isDirectory()) throw new ToolError("Isso é um arquivo, não uma pasta.");
      const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).slice(0, 300);
      const itens = await Promise.all(names.map(async (n) => {
        const s = await stat(path.join(dir, n)).catch(() => null);
        return s ? { nome: n, tipo: s.isDirectory() ? "pasta" : "arquivo", tamanho_kb: s.isDirectory() ? null : Math.ceil(s.size / 1024), modificado: s.mtime.toISOString().slice(0, 16).replace("T", " ") } : null;
      }));
      return { pasta: rel(dir), itens: itens.filter(Boolean) };
    },
  }),
  tool({
    name: "ler_arquivo",
    description: "Lê um arquivo de texto da pasta dos xodós (txt, md, csv, json, html...). PDF, Word e Excel ainda não.",
    category: "leitura",
    // Um arquivo pode ter vindo de fora (baixado, recebido): a execução segue cautelosa depois.
    taints: true,
    input: z.object({ caminho: caminho.min(1), a_partir_de: z.number().int().min(0).default(0) }),
    summarize: (i) => `ler ${i.caminho}`,
    async execute(_ctx, i) {
      const file = await inside(i.caminho, true);
      const s = await stat(file);
      if (s.isDirectory()) throw new ToolError("Isso é uma pasta; use listar_arquivos.");
      const ext = path.extname(file).toLowerCase();
      if (!TEXT_EXT.has(ext)) throw new ToolError(`Ainda não sei ler arquivos ${ext || "sem extensão"}. Leio txt, md, csv, json, html e parecidos.`);
      const buf = await readFile(file);
      const text = buf.subarray(0, MAX_READ).toString("utf8");
      const slice = text.slice(i.a_partir_de, i.a_partir_de + MAX_CHARS);
      const rest = text.length - (i.a_partir_de + slice.length);
      return { caminho: rel(file), texto: slice, ...(rest > 0 ? { continua: `Faltam ${rest} caracteres; chame de novo com a_partir_de = ${i.a_partir_de + slice.length}.` } : {}), ...(s.size > MAX_READ ? { aviso: "Arquivo grande: li só o começo." } : {}) };
    },
  }),
  tool({
    name: "escrever_arquivo",
    description: "Cria um arquivo de texto na pasta dos xodós (relatório, lista, resumo, planilha .csv). Para trocar um que já existe, use substituir = true.",
    category: "alteracao",
    input: z.object({
      caminho: caminho.min(1).describe("Ex.: resumos/2026-10-28.md"),
      conteudo: z.string().max(500_000),
      substituir: z.boolean().default(false),
    }),
    summarize: (i) => `${i.substituir ? "substituir" : "criar"} o arquivo ${i.caminho}`,
    async execute(_ctx, i) {
      const ext = path.extname(i.caminho).toLowerCase();
      if (!TEXT_EXT.has(ext)) throw new ToolError("Use uma extensão de texto: .md, .txt, .csv, .json ou .html.");
      const file = await inside(i.caminho, false);
      const exists = await stat(file).then(() => true, () => false);
      if (exists && !i.substituir) throw new ToolError("Esse arquivo já existe. Escolha outro nome ou use substituir = true.");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, i.conteudo, "utf8");
      return { caminho: rel(file), criado: !exists, substituido: exists };
    },
  }),
  tool({
    name: "mover_arquivo",
    description: "Move ou renomeia um arquivo ou pasta dentro da pasta dos xodós.",
    category: "alteracao",
    input: z.object({ de: caminho.min(1), para: caminho.min(1) }),
    summarize: (i) => `mover ${i.de} para ${i.para}`,
    async execute(_ctx, i) {
      const from = await inside(i.de, true);
      const to = await inside(i.para, false);
      if (await stat(to).then(() => true, () => false)) throw new ToolError("Já existe algo com esse nome no destino.");
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      return { de: rel(from), para: rel(to) };
    },
  }),
  tool({
    name: "apagar_arquivo",
    description: `Tira um arquivo ou pasta da pasta dos xodós, movendo para a "${TRASH}" (dá para recuperar).`,
    category: "exclusao",
    input: z.object({ caminho: caminho.min(1) }),
    summarize: (i) => `mandar ${i.caminho} para a lixeira dos xodós`,
    async execute(_ctx, i) {
      const file = await inside(i.caminho, true);
      if (file === ROOT) throw new ToolError("Não dá para apagar a pasta principal.");
      const trash = path.join(ROOT!, TRASH);
      if (file === trash || file.startsWith(trash + path.sep)) throw new ToolError("Já está na lixeira.");
      await mkdir(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dest = path.join(trash, `${stamp} ${path.basename(file)}`);
      await rename(file, dest);
      return { movido_para: rel(dest) };
    },
  }),
];
