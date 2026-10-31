import { z } from "zod";
import { appCall, ToolError, openApp, type ToolDef } from "../../xodos/tools";
import { requestJson } from "../http";
import { clip, tool } from "./common";

/**
 * Notion da agência: buscar, ler páginas, consultar bases, criar e atualizar páginas. O xodó só
 * enxerga as páginas que a agência compartilhou com a integração do Spherum na hora do login.
 */

const NOTION = "https://api.notion.com/v1";
/** Versão da API do Notion. A 2022-06-28 continua aceita; bases com várias fontes de dados pedem a 2025-09-03. */
const NOTION_VERSION = "2022-06-28";
const MAX_BLOCKS = 300;

type Notion = Awaited<ReturnType<typeof openApp>>;
type RichText = { plain_text?: string; href?: string | null };
type Block = { id: string; type: string; has_children?: boolean; [key: string]: unknown };
type Property = { id?: string; type: string; [key: string]: unknown };
type Page = { id: string; object: "page"; url?: string; last_edited_time?: string; archived?: boolean; parent?: { type: string; database_id?: string; page_id?: string }; properties?: Record<string, Property> };
type Database = { id: string; object: "database"; url?: string; last_edited_time?: string; title?: RichText[]; properties?: Record<string, Property> };

const call = <T = Record<string, unknown>>(n: Notion, path: string, init: Parameters<typeof requestJson>[2] = {}) =>
  appCall(() =>
    requestJson<T>(n.http, `${NOTION}${path}`, {
      ...init,
      bearer: n.accessToken,
      headers: { "notion-version": NOTION_VERSION, ...(init.headers as Record<string, string> | undefined) },
    }),
  );

const plain = (rt: unknown) => (Array.isArray(rt) ? (rt as RichText[]).map((t) => t.plain_text ?? "").join("") : "");

/** Ids do Notion chegam com ou sem hífens, ou dentro de um link. */
export function notionId(ref: string): string {
  const hex = ref.replace(/-/g, "").match(/[0-9a-f]{32}(?![0-9a-f])/i)?.[0];
  if (!hex) throw new ToolError("Id do Notion inválido. Use o id ou o link da página.");
  return hex.toLowerCase();
}

function titleOf(item: Page | Database): string {
  if (item.object === "database") return plain(item.title) || "(sem título)";
  const prop = Object.values(item.properties ?? {}).find((p) => p.type === "title");
  return (prop && plain(prop.title)) || "(sem título)";
}

/** Valor legível de uma propriedade do Notion. */
export function propValue(p: Property): unknown {
  const v = p[p.type] as Record<string, unknown> | unknown[] | string | number | boolean | null;
  switch (p.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "select":
    case "status":
      return (v as { name?: string } | null)?.name ?? null;
    case "multi_select":
      return ((v as { name: string }[]) ?? []).map((o) => o.name);
    case "date": {
      const d = v as { start?: string; end?: string | null } | null;
      return d ? (d.end ? `${d.start} → ${d.end}` : d.start) : null;
    }
    case "people":
      return ((v as { name?: string; id: string }[]) ?? []).map((u) => u.name ?? u.id);
    case "relation":
      return ((v as { id: string }[]) ?? []).map((r) => r.id);
    case "files":
      return ((v as { name?: string }[]) ?? []).map((f) => f.name);
    case "formula": {
      const f = v as Record<string, unknown>;
      return f ? f[f.type as string] : null;
    }
    case "rollup": {
      const r = v as Record<string, unknown>;
      const inner = r?.[r.type as string];
      return Array.isArray(inner) ? inner.length : (inner ?? null);
    }
    case "unique_id": {
      const u = v as { prefix?: string | null; number?: number };
      return u ? `${u.prefix ? `${u.prefix}-` : ""}${u.number}` : null;
    }
    case "created_by":
    case "last_edited_by":
      return (v as { name?: string } | null)?.name ?? null;
    default:
      return v ?? null;
  }
}

const properties = (props: Record<string, Property> | undefined) =>
  Object.fromEntries(Object.entries(props ?? {}).map(([name, p]) => [name, propValue(p)]));

const BLOCK_PREFIX: Record<string, string> = {
  heading_1: "# ",
  heading_2: "## ",
  heading_3: "### ",
  bulleted_list_item: "- ",
  numbered_list_item: "1. ",
  quote: "> ",
  callout: "> ",
  toggle: "▸ ",
};

/** Bloco em uma linha de texto (estilo Markdown). */
export function blockText(b: Block): string | null {
  const body = b[b.type] as Record<string, unknown> | undefined;
  if (b.type === "divider") return "---";
  if (b.type === "child_page") return `[página] ${(body as { title?: string })?.title ?? ""} (id ${b.id})`;
  if (b.type === "child_database") return `[base] ${(body as { title?: string })?.title ?? ""} (id ${b.id})`;
  if (b.type === "to_do") return `${body?.checked ? "[x]" : "[ ]"} ${plain(body?.rich_text)}`;
  if (b.type === "code") return `\`\`\`\n${plain(body?.rich_text)}\n\`\`\``;
  if (b.type === "bookmark" || b.type === "embed" || b.type === "link_preview") return String(body?.url ?? "");
  if (body && "rich_text" in body) return `${BLOCK_PREFIX[b.type] ?? ""}${plain(body.rich_text)}`;
  return null;
}

async function pageText(n: Notion, id: string): Promise<{ text: string; cut: boolean }> {
  const lines: string[] = [];
  let count = 0;
  const walk = async (blockId: string, depth: number) => {
    let cursor: string | undefined;
    do {
      const r = await call<{ results: Block[]; next_cursor: string | null }>(
        n,
        `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      );
      for (const b of r.results) {
        if (count >= MAX_BLOCKS) return;
        count += 1;
        const line = blockText(b);
        if (line !== null) lines.push(`${"  ".repeat(depth)}${line}`);
        if (b.has_children && depth < 2 && !["child_page", "child_database"].includes(b.type)) await walk(b.id, depth + 1);
      }
      cursor = r.next_cursor ?? undefined;
    } while (cursor && count < MAX_BLOCKS);
  };
  await walk(id, 0);
  return { text: lines.join("\n"), cut: count >= MAX_BLOCKS };
}

const richText = (text: string) => {
  // O Notion aceita até 2000 caracteres por trecho.
  const chunks = text.match(/[\s\S]{1,2000}/g) ?? [""];
  return chunks.map((content) => ({ type: "text", text: { content } }));
};

/** Texto (estilo Markdown simples) em blocos do Notion. */
export function textToBlocks(text: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      for (i += 1; i < lines.length && !lines[i].startsWith("```"); i += 1) code.push(lines[i]);
      blocks.push({ type: "code", code: { language: "plain text", rich_text: richText(code.join("\n")) } });
      continue;
    }
    if (!line.trim()) continue;
    const rules: [RegExp, string, Record<string, unknown>?][] = [
      [/^### (.*)/, "heading_3"],
      [/^## (.*)/, "heading_2"],
      [/^# (.*)/, "heading_1"],
      [/^[-*] \[([ xX])\] (.*)/, "to_do"],
      [/^[-*] (.*)/, "bulleted_list_item"],
      [/^\d+[.)] (.*)/, "numbered_list_item"],
      [/^> (.*)/, "quote"],
      [/^---+$/, "divider"],
    ];
    const rule = rules.find(([re]) => re.test(line));
    if (!rule) {
      blocks.push({ type: "paragraph", paragraph: { rich_text: richText(line) } });
      continue;
    }
    const [re, type] = rule;
    const m = line.match(re)!;
    if (type === "divider") blocks.push({ type, divider: {} });
    else if (type === "to_do") blocks.push({ type, to_do: { checked: m[1].toLowerCase() === "x", rich_text: richText(m[2]) } });
    else blocks.push({ type, [type]: { rich_text: richText(m[1]) } });
  }
  return blocks;
}

type Simple = string | number | boolean | string[] | null;

/** Valor simples para o formato de propriedade do Notion, pelo tipo na base. */
export function toProperty(name: string, schema: Property | undefined, value: Simple): Record<string, unknown> {
  if (!schema) throw new ToolError(`A base não tem a propriedade "${name}".`);
  const text = Array.isArray(value) ? value.join(", ") : value === null ? "" : String(value);
  switch (schema.type) {
    case "title":
      return { title: richText(text) };
    case "rich_text":
      return { rich_text: richText(text) };
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
      if (value !== null && !Number.isFinite(n)) throw new ToolError(`"${name}" precisa ser um número.`);
      return { number: value === null ? null : n };
    }
    case "select":
      return { select: text ? { name: text } : null };
    case "status":
      return { status: { name: text } };
    case "multi_select": {
      const list = Array.isArray(value) ? value : text.split(",").map((s) => s.trim()).filter(Boolean);
      return { multi_select: list.map((v) => ({ name: v })) };
    }
    case "date": {
      if (!text) return { date: null };
      const [start, end] = text.split("→").map((s) => s.trim());
      return { date: { start, ...(end ? { end } : {}) } };
    }
    case "checkbox":
      return { checkbox: value === true || /^(true|sim|1|x)$/i.test(text) };
    case "url":
      return { url: text || null };
    case "email":
      return { email: text || null };
    case "phone_number":
      return { phone_number: text || null };
    default:
      throw new ToolError(`Ainda não consigo preencher "${name}" (tipo ${schema.type}).`);
  }
}

const simple = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50), z.null()]);
const props = z.record(z.string().max(100), simple).describe('Propriedades da base, por nome. Ex.: {"Status": "Em andamento", "Prazo": "2026-11-01"}');

function mapProperties(schema: Record<string, Property>, values: Record<string, Simple>) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, toProperty(name, schema[name], value)]));
}

async function appendBlocks(n: Notion, id: string, blocks: Record<string, unknown>[]) {
  for (let i = 0; i < blocks.length; i += 100) {
    await call(n, `/blocks/${id}/children`, { method: "PATCH", json: { children: blocks.slice(i, i + 100) } });
  }
}

const ref = z.string().min(1).max(300).describe("Id ou link do Notion");

export const NOTION_TOOLS: ToolDef[] = [
  tool({
    name: "buscar_no_notion",
    description: "Busca páginas e bases no Notion da agência pelo título, da editada mais recentemente para a mais antiga.",
    category: "leitura",
    app: "notion",
    input: z.object({
      busca: z.string().max(200).default(""),
      tipo: z.enum(["pagina", "base"]).optional(),
      quantidade: z.number().int().min(1).max(50).default(15),
    }),
    summarize: (i) => `buscar no Notion${i.busca ? ` (${i.busca})` : ""}`,
    async execute(ctx, i) {
      const n = await openApp(ctx, "notion");
      const r = await call<{ results: (Page | Database)[] }>(n, "/search", {
        method: "POST",
        json: {
          query: i.busca,
          page_size: i.quantidade,
          sort: { direction: "descending", timestamp: "last_edited_time" },
          ...(i.tipo ? { filter: { property: "object", value: i.tipo === "base" ? "database" : "page" } } : {}),
        },
      });
      return {
        resultados: r.results.map((item) => ({
          id: item.id,
          tipo: item.object === "database" ? "base" : "pagina",
          titulo: titleOf(item),
          link: item.url ?? null,
          editado_em: item.last_edited_time ?? null,
        })),
      };
    },
  }),
  tool({
    name: "ler_pagina_do_notion",
    description: "Lê uma página do Notion: propriedades e conteúdo em texto.",
    category: "leitura",
    app: "notion",
    input: z.object({ id: ref }),
    summarize: () => "ler página do Notion",
    async execute(ctx, i) {
      const n = await openApp(ctx, "notion");
      const id = notionId(i.id);
      const page = await call<Page>(n, `/pages/${id}`);
      const { text, cut } = await pageText(n, id);
      return {
        id: page.id,
        titulo: titleOf(page),
        link: page.url ?? null,
        propriedades: properties(page.properties),
        conteudo: clip(text, 30_000) + (cut ? "\n… (página longa: mostrei os primeiros blocos)" : ""),
      };
    },
  }),
  tool({
    name: "consultar_base_do_notion",
    description:
      "Lista as linhas de uma base (database) do Notion com as propriedades. Aceita um filtro no formato da API do Notion.",
    category: "leitura",
    app: "notion",
    input: z.object({
      id: ref,
      filtro: z.record(z.string(), z.unknown()).optional().describe('Filtro do Notion. Ex.: {"property": "Status", "status": {"equals": "Atrasado"}}'),
      quantidade: z.number().int().min(1).max(100).default(50),
    }),
    summarize: () => "consultar base do Notion",
    async execute(ctx, i) {
      const n = await openApp(ctx, "notion");
      const r = await call<{ results: Page[]; has_more?: boolean }>(n, `/databases/${notionId(i.id)}/query`, {
        method: "POST",
        json: { page_size: i.quantidade, ...(i.filtro ? { filter: i.filtro } : {}) },
      });
      return {
        linhas: r.results.map((p) => ({ id: p.id, link: p.url ?? null, propriedades: properties(p.properties) })),
        tem_mais: r.has_more ?? false,
      };
    },
  }),
  tool({
    name: "criar_pagina_no_notion",
    description:
      "Cria uma página dentro de outra página ou uma linha numa base do Notion. O texto aceita Markdown simples (#, -, 1., [ ], >, ```).",
    category: "alteracao",
    app: "notion",
    input: z.object({
      dentro_de: ref.describe("Id ou link da página ou da base onde criar"),
      titulo: z.string().min(1).max(2000),
      texto: z.string().max(100_000).optional(),
      propriedades: props.optional(),
    }),
    summarize: (i) => `criar a página "${i.titulo}" no Notion`,
    async execute(ctx, i) {
      const n = await openApp(ctx, "notion");
      const parentId = notionId(i.dentro_de);
      // Descobre se o pai é uma base (tem esquema de propriedades) ou uma página.
      let db: Database | null = null;
      try {
        db = await call<Database>(n, `/databases/${parentId}`);
      } catch {
        db = null;
      }
      let body: Record<string, unknown>;
      if (db) {
        const schema = db.properties ?? {};
        const titleName = Object.entries(schema).find(([, p]) => p.type === "title")?.[0] ?? "Name";
        body = {
          parent: { database_id: parentId },
          properties: { ...mapProperties(schema, i.propriedades ?? {}), [titleName]: { title: richText(i.titulo) } },
        };
      } else {
        if (i.propriedades && Object.keys(i.propriedades).length) throw new ToolError("Propriedades só existem em linhas de uma base.");
        body = { parent: { page_id: parentId }, properties: { title: { title: richText(i.titulo) } } };
      }
      const blocks = i.texto ? textToBlocks(i.texto) : [];
      const page = await call<Page>(n, "/pages", { method: "POST", json: { ...body, children: blocks.slice(0, 100) } });
      if (blocks.length > 100) await appendBlocks(n, page.id, blocks.slice(100));
      return { id: page.id, link: page.url ?? null, titulo: i.titulo };
    },
  }),
  tool({
    name: "adicionar_na_pagina_do_notion",
    description: "Acrescenta texto no fim de uma página do Notion (Markdown simples).",
    category: "alteracao",
    app: "notion",
    input: z.object({ id: ref, texto: z.string().min(1).max(100_000) }),
    summarize: () => "acrescentar texto numa página do Notion",
    async execute(ctx, i) {
      const n = await openApp(ctx, "notion");
      const blocks = textToBlocks(i.texto);
      await appendBlocks(n, notionId(i.id), blocks);
      return { blocos_adicionados: blocks.length };
    },
  }),
  tool({
    name: "atualizar_pagina_do_notion",
    description: "Muda propriedades de uma linha de base do Notion (status, responsável, prazo…).",
    category: "alteracao",
    app: "notion",
    input: z.object({ id: ref, propriedades: props }),
    summarize: (i) => `atualizar ${Object.keys(i.propriedades).join(", ")} no Notion`,
    async execute(ctx, i) {
      const n = await openApp(ctx, "notion");
      const id = notionId(i.id);
      const page = await call<Page>(n, `/pages/${id}`);
      const schema = page.properties ?? {};
      const updated = await call<Page>(n, `/pages/${id}`, { method: "PATCH", json: { properties: mapProperties(schema, i.propriedades) } });
      return { id: updated.id, propriedades: properties(updated.properties) };
    },
  }),
  tool({
    name: "arquivar_pagina_do_notion",
    description: "Arquiva uma página do Notion (vai para a lixeira do Notion e dá para restaurar).",
    category: "exclusao",
    app: "notion",
    input: z.object({ id: ref }),
    summarize: () => "arquivar uma página do Notion",
    async execute(ctx, i) {
      const n = await openApp(ctx, "notion");
      await call(n, `/pages/${notionId(i.id)}`, { method: "PATCH", json: { archived: true } });
      return { arquivada: true };
    },
  }),
];
