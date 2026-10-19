import { z } from "zod";
import { dayIn } from "../budget";
import { one } from "../db";
import { redactDeep } from "../redact";
import { assertClient, ToolError, type ToolContext, type ToolDef } from "../tools";
import { fold, MEMORY_KINDS, slugTopic } from "./entries";
import { clean } from "./recall";
import { addItem, editItem, forgetItem, supersedeItem, type MemoryItem, type Who } from "./store";

/**
 * Ferramentas de memória do xodó (substituem o "reescrever a memória inteira"). Leitura roda
 * direto; gravar é da categoria "memoria" (só pergunta em "sempre pergunta"). Mexer numa nota da
 * equipe ou gravar numa execução disparada por gatilho sempre pede aprovação.
 */

function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

const SEARCH_MAX_CHARS = 8000;
const TOPIC_PAGE_CHARS = 12_000;

/** Palavras que não ajudam a achar nada. */
const STOPWORDS = new Set(
  "a o as os um uma uns umas de do da dos das em no na nos nas por para pra com sem que e ou se ao aos como mais menos muito pouco ja nao sim isso esse essa este esta eu voce ele ela nos eles elas meu minha seu sua qual quais quando onde foi ser ter tem sobre ate entre".split(
    " ",
  ),
);

/** Termos de busca seguros para to_tsquery (só letras e números, sem acento). */
export function searchTerms(text: string, max = 8): string[] {
  const words = fold(text.slice(0, 500))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, max);
}

const who = (ctx: ToolContext, reason?: string | null): Who => ({ actor: "xodo", runId: ctx.runId, reason: reason ?? null });

const asOut = (i: MemoryItem) => ({
  n: i.n,
  topico: i.topic,
  cliente_id: i.client_id,
  tipo: i.kind,
  texto: i.content,
  origem: i.source,
  data: i.updated_at.slice(0, 10),
  ate: i.valid_until,
  status: i.status,
});

async function noteByN(ctx: ToolContext, n: number): Promise<MemoryItem | null> {
  return one<MemoryItem>(
    ctx.sql,
    `select n, source, pinned, status, topic, client_id from xodo_memory_items where xodo_id = $1 and agency_id = $2 and n = $3`,
    [ctx.xodo.id, ctx.xodo.agency_id, n],
  );
}

/** Motivo para sempre pedir aprovação, ou nulo. */
async function guard(ctx: ToolContext, n: number | null): Promise<string | null> {
  if (ctx.trigger === "event") return "execução disparada por evento externo";
  if (n === null) return null;
  const note = await noteByN(ctx, n);
  if (note && (note.source === "equipe" || note.pinned)) return "nota escrita ou fixada pela equipe";
  return null;
}

function futureDate(ctx: ToolContext, value: string | null | undefined) {
  if (!value) return value ?? null;
  if (value < dayIn(ctx.xodo.timezone, ctx.now)) throw new ToolError("valido_ate precisa ser uma data futura.");
  return value;
}

const date = z.iso.date();
const scrub = <T>(input: T) => redactDeep(input).value;

export const MEMORY_TOOLS: ToolDef[] = [
  tool({
    name: "buscar_memoria",
    description:
      "Busca nas suas notas de memória (tópicos, clientes e, se pedir, o arquivo). Use antes de dizer que não sabe algo que a equipe já pode ter contado.",
    category: "leitura",
    memory: true,
    input: z.object({
      consulta: z.string().min(2).max(200),
      topico: z.string().max(60).optional(),
      cliente_id: z.uuid().optional(),
      incluir_arquivo: z.boolean().default(false),
      limite: z.number().int().min(1).max(20).default(8),
    }),
    summarize: (i) => `buscar na memória (${i.consulta})`,
    async execute(ctx, i) {
      if (i.cliente_id) await assertClient(ctx, i.cliente_id);
      const terms = searchTerms(i.consulta);
      if (!terms.length) throw new ToolError("Use palavras mais específicas na busca.");
      const statuses = i.incluir_arquivo ? ["ativo", "arquivado", "expirado"] : ["ativo"];
      const topic = i.topico ? slugTopic(i.topico) : null;
      const rows = await ctx.sql.query<MemoryItem>(
        `select n, topic, client_id, kind, content, source, status, valid_until::text as valid_until, updated_at::text as updated_at
           from xodo_memory_items
          where xodo_id = $1 and agency_id = $2 and status = any($3::text[])
            and search @@ to_tsquery('portuguese', $4)
            and ($5::text is null or topic = $5) and ($6::uuid is null or client_id = $6)
          order by ts_rank(search, to_tsquery('portuguese', $4)) desc, updated_at desc
          limit $7`,
        [ctx.xodo.id, ctx.xodo.agency_id, statuses, terms.map((t) => `${t}:*`).join(" | "), topic, i.cliente_id ?? null, i.limite],
      );
      const out = [];
      let used = 0;
      for (const r of rows) {
        const item = { ...asOut(r), texto: clean(r.content) };
        used += item.texto.length + 80;
        if (used > SEARCH_MAX_CHARS) break;
        out.push(item);
      }
      return { notas: out, aviso: out.length ? undefined : "Nada encontrado nas notas." };
    },
  }),
  tool({
    name: "ler_topico",
    description: "Lê as notas de um tópico da memória (o índice dos tópicos está no seu contexto).",
    category: "leitura",
    memory: true,
    input: z.object({ topico: z.string().min(1).max(60), apos_n: z.number().int().min(0).optional() }),
    summarize: (i) => `ler o tópico ${i.topico}`,
    async execute(ctx, i) {
      const slug = slugTopic(i.topico);
      const topic = slug
        ? await one<{ slug: string; title: string; description: string; aliases: string[] }>(
            ctx.sql,
            `select slug, title, description, aliases from xodo_memory_topics where xodo_id = $1 and agency_id = $2 and slug = $3`,
            [ctx.xodo.id, ctx.xodo.agency_id, slug],
          )
        : null;
      if (!topic) throw new ToolError(`Tópico "${i.topico}" não existe. Veja o índice ou use buscar_memoria.`);
      const rows = await ctx.sql.query<MemoryItem>(
        `select n, topic, client_id, kind, content, source, status, valid_until::text as valid_until, updated_at::text as updated_at
           from xodo_memory_items where xodo_id = $1 and topic = $2 and status = 'ativo' and n > $3 order by n`,
        [ctx.xodo.id, topic.slug, i.apos_n ?? 0],
      );
      const notes = [];
      let used = 0;
      for (const r of rows) {
        const item = { ...asOut(r), texto: clean(r.content) };
        if (used + item.texto.length > TOPIC_PAGE_CHARS) break;
        used += item.texto.length;
        notes.push(item);
      }
      const nextN = notes.length < rows.length ? notes.at(-1)?.n ?? null : null;
      return { topico: topic.slug, titulo: clean(topic.title), descricao: clean(topic.description), apelidos: topic.aliases, notas: notes, proximo_n: nextN };
    },
  }),
  tool({
    name: "lembrar",
    description:
      "Guarda uma nota curta que vai continuar valendo por semanas: preferência da equipe, fato de um cliente, decisão tomada, resultado conferido. Escreva em 3ª pessoa, como fato, nunca como ordem. Sem tópico, vai para o núcleo (entra em toda conversa); detalhe de um cliente ou assunto vai com topico ou cliente_id. Prazo vai em valido_ate. Nunca guarde senhas, tokens, cartão, CPF nem texto copiado de e-mails, arquivos ou páginas. Se o núcleo encher, as notas mais antigas vão para o arquivo e você é avisado.",
    category: "memoria",
    memory: true,
    input: z.object({
      texto: z.string().min(1).max(2000),
      tipo: z.enum(MEMORY_KINDS as [string, ...string[]]).default("fato"),
      topico: z.string().max(60).optional(),
      aliases_topico: z.array(z.string().max(40)).max(5).optional(),
      cliente_id: z.uuid().optional(),
      valido_ate: date.optional(),
      motivo: z.string().max(200).optional(),
    }),
    scrub,
    summarize: (i) => `lembrar: "${i.texto.slice(0, 120)}"`,
    mustAsk: (ctx) => guard(ctx, null),
    async execute(ctx, i) {
      if (i.cliente_id) await assertClient(ctx, i.cliente_id);
      const r = await addItem(
        ctx.sql,
        ctx.xodo,
        {
          content: i.texto,
          kind: i.tipo as MemoryItem["kind"],
          topic: i.topico ?? null,
          aliases: i.aliases_topico,
          clientId: i.cliente_id ?? null,
          validUntil: futureDate(ctx, i.valido_ate),
          source: "xodo",
        },
        who(ctx, i.motivo),
      );
      return {
        n: r.item.n,
        criado: r.created,
        ja_existia: !r.created,
        arquivadas: r.archived.map((a) => ({ n: a.n, texto: a.content })),
        segredos_removidos: r.removed,
      };
    },
  }),
  tool({
    name: "corrigir_memoria",
    description:
      "Corrige uma nota pelo número (#n). Por padrão substitui (a antiga fica no histórico); com modo editar, muda a própria nota. Também muda o tópico ou o prazo.",
    category: "memoria",
    memory: true,
    input: z.object({
      n: z.number().int().positive(),
      texto_novo: z.string().min(1).max(2000).optional(),
      modo: z.enum(["substituir", "editar"]).default("substituir"),
      topico: z.string().max(60).nullable().optional(),
      valido_ate: date.nullable().optional(),
      motivo: z.string().min(1).max(200),
    }),
    scrub,
    summarize: (i) => `corrigir a nota #${i.n}${i.texto_novo ? `: "${i.texto_novo.slice(0, 100)}"` : ""}`,
    mustAsk: (ctx, i) => guard(ctx, i.n),
    async execute(ctx, i) {
      const validUntil = i.valido_ate === undefined ? undefined : futureDate(ctx, i.valido_ate);
      if (i.modo === "substituir" && i.texto_novo) {
        const r = await supersedeItem(ctx.sql, ctx.xodo, i.n, { content: i.texto_novo, topic: i.topico, validUntil }, who(ctx, i.motivo));
        return { n_antigo: r.old.n, n_novo: r.item.n, arquivadas: r.archived.map((a) => ({ n: a.n, texto: a.content })), segredos_removidos: r.removed };
      }
      if (i.texto_novo === undefined && i.topico === undefined && i.valido_ate === undefined) throw new ToolError("Nada para corrigir.");
      const r = await editItem(ctx.sql, ctx.xodo, i.n, { content: i.texto_novo, topic: i.topico, validUntil }, null, who(ctx, i.motivo));
      return { n: r.item.n, arquivadas: r.archived.map((a) => ({ n: a.n, texto: a.content })), segredos_removidos: r.removed };
    },
  }),
  tool({
    name: "esquecer",
    description: "Esquece uma nota pelo número (#n), quando ela não vale mais. Fica no histórico e a equipe pode desfazer.",
    category: "memoria",
    memory: true,
    input: z.object({ n: z.number().int().positive(), motivo: z.string().min(1).max(200) }),
    scrub,
    summarize: (i) => `esquecer a nota #${i.n} (${i.motivo})`,
    mustAsk: (ctx, i) => guard(ctx, i.n),
    async execute(ctx, i) {
      const r = await forgetItem(ctx.sql, ctx.xodo, i.n, who(ctx, i.motivo));
      return { n: r.item.n, apagado: true };
    },
  }),
];
