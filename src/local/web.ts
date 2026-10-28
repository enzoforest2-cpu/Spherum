import { z } from "zod";
import { assertPublicUrl, type Resolver } from "../xodos/net";
import { ToolError } from "../xodos/tool-error";
import type { ToolDef } from "../xodos/tools";

/**
 * Internet para os xodós: pesquisar e ler páginas. Tudo só leitura, mas o conteúdo vem de fora,
 * por isso as duas ferramentas marcam a execução como "de fora" (taints): o que o xodó escrever
 * na memória depois disso pede a sua aprovação.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Xodos/0.1";
const MAX_BYTES = 2_000_000;
const MAX_CHARS = 12_000;

export type WebDeps = { fetch?: typeof fetch; resolve?: Resolver };
let deps: WebDeps = {};
/** Para os testes trocarem a rede por respostas prontas. */
export function setWebDeps(d: WebDeps) {
  deps = d;
}

/** Baixa uma página pública, seguindo no máximo 5 redirecionamentos, cada um conferido de novo. */
async function getPublic(input: string, accept = "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5") {
  const doFetch = deps.fetch ?? fetch;
  let url = input;
  for (let hop = 0; hop < 6; hop++) {
    let checked: URL;
    try {
      checked = await assertPublicUrl(url, deps.resolve);
    } catch (error) {
      throw new ToolError((error as Error).message);
    }
    const res = await doFetch(checked, { redirect: "manual", headers: { "user-agent": UA, accept, "accept-language": "pt-BR,pt;q=0.9,en;q=0.6" }, signal: AbortSignal.timeout(20_000) })
      .catch(() => { throw new ToolError("Não consegui abrir esse endereço agora."); });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, checked).toString();
      continue;
    }
    if (!res.ok) throw new ToolError(`A página respondeu ${res.status}.`);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { url: checked.toString(), type: res.headers.get("content-type") ?? "", body };
  }
  throw new ToolError("Redirecionamentos demais.");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Texto legível de um HTML: tira scripts, estilos e menus, mantém títulos, parágrafos e listas. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<(main|article)[\s\S]*?<\/\1>/i)?.[0];
  if (main && main.length > 500) body = main;
  const text = decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<h([1-6])[^>]*>/gi, "\n## ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/** Resultados da página leve do DuckDuckGo (não precisa de chave). */
export function parseDuckResults(html: string, limit: number) {
  const out: { titulo: string; url: string; resumo: string }[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<\/div>)/g;
  for (const m of html.matchAll(re)) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const clean = (s: string | undefined) => decodeEntities((s ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    out.push({ titulo: clean(m[2]), url: href, resumo: clean(m[3]) });
    if (out.length >= limit) break;
  }
  return out;
}

function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

export const WEB_TOOLS: ToolDef[] = [
  tool({
    name: "pesquisar_web",
    description:
      "Pesquisa na internet e devolve os primeiros resultados (título, endereço e um trecho). Para ler um resultado inteiro, use ler_pagina com o endereço.",
    category: "leitura",
    taints: true,
    input: z.object({
      consulta: z.string().min(2).max(300).describe("O que pesquisar, como você escreveria num buscador."),
      quantidade: z.number().int().min(1).max(10).default(6),
    }),
    summarize: (i) => `pesquisar: ${i.consulta}`,
    async execute(_ctx, i) {
      const page = await getPublic(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(i.consulta)}&kl=br-pt`);
      const resultados = parseDuckResults(page.body, i.quantidade);
      if (!resultados.length) {
        return { resultados: [], aviso: "O buscador não devolveu resultados agora (pode ter limitado as consultas). Tente outras palavras ou abra uma página conhecida com ler_pagina." };
      }
      return { resultados };
    },
  }),
  tool({
    name: "ler_pagina",
    description:
      "Abre uma página pública da internet e devolve o texto dela (sem menus e propagandas). Use para ler um resultado da pesquisa, uma notícia ou a página de um produto.",
    category: "leitura",
    taints: true,
    input: z.object({
      url: z.string().url().describe("Endereço completo, começando com https://"),
      a_partir_de: z.number().int().min(0).default(0).describe("Para páginas longas: de que caractere continuar."),
    }),
    summarize: (i) => `ler a página ${i.url}`,
    async execute(_ctx, i) {
      const page = await getPublic(i.url);
      const isHtml = /html|xml/.test(page.type) || /^\s*</.test(page.body);
      const { title, text } = isHtml ? htmlToText(page.body) : { title: "", text: page.body };
      const slice = text.slice(i.a_partir_de, i.a_partir_de + MAX_CHARS);
      const rest = text.length - (i.a_partir_de + slice.length);
      return {
        url: page.url,
        titulo: title,
        texto: slice,
        ...(rest > 0 ? { continua: `Faltam ${rest} caracteres. Para continuar, chame de novo com a_partir_de = ${i.a_partir_de + slice.length}.` } : {}),
      };
    },
  }),
];
