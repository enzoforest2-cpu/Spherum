import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dayIn } from "../budget";
import { json, num, one, parseJson, type Sql } from "../db";
import { XodoError } from "../errors";
import { redactSecrets } from "../redact";
import type { Xodo } from "../types";
import { fold, MEMORY_KINDS, slugTopic, type MemoryKind } from "./entries";
import { CORE_MAX_NOTES } from "./recall";
import {
  addItem,
  coreUsage,
  editItem,
  forgetItem,
  listChanges,
  listTopics,
  MemoryConflict,
  purgeItem,
  revertBatch,
  withMemoryLock,
  type MemoryItem,
  type MemoryXodo,
  type Who,
} from "./store";

/**
 * O que a equipe faz na aba "Memória" (as rotas de /api/xodos/:id/memory chamam daqui): listar
 * com filtros e o medidor do núcleo, criar, editar com versão, apagar, excluir de vez, desfazer
 * um lote, editar e apagar tópicos, ver as capturas com o custo e exportar em markdown.
 * O papel já foi conferido na rota; fixar e excluir de vez pedem `manage` (owner ou admin).
 * Toda gravação de nota passa por store.ts (limpeza, trava, versão e diário).
 */

/** Quem está na tela: o usuário e se ele pode gerenciar (owner ou admin). */
export type TeamActor = { userId: string; manage: boolean };

/** Nota como a tela recebe (sem a identidade usada para não duplicar). */
export type TeamNote = Omit<MemoryItem, "identity">;

export function teamNote(item: MemoryItem): TeamNote {
  return {
    id: item.id,
    xodo_id: item.xodo_id,
    agency_id: item.agency_id,
    n: item.n,
    topic: item.topic,
    client_id: item.client_id,
    kind: item.kind,
    content: item.content,
    source: item.source,
    status: item.status,
    pinned: item.pinned,
    valid_until: item.valid_until,
    superseded_by: item.superseded_by,
    confidence: item.confidence,
    kept_in_core: item.kept_in_core,
    run_id: item.run_id,
    created_by: item.created_by,
    version: item.version,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

/** Corpo do 409 quando a nota mudou desde que a tela abriu (vai junto a versão atual). */
export function conflictBody(error: unknown): { error: string; atual: TeamNote } | null {
  return error instanceof MemoryConflict ? { error: error.message, atual: teamNote(error.current) } : null;
}

const memXodo = (xodo: Xodo): MemoryXodo => ({ id: xodo.id, agency_id: xodo.agency_id, memory_core_chars: xodo.memory_core_chars });

const who = (actor: TeamActor, reason?: string | null): Who => ({ actor: "equipe", userId: actor.userId, reason: reason || null });

/** Maior valor de uma coluna integer do Postgres (#n e versão); acima disso o banco daria erro 500. */
const INT_MAX = 2_147_483_647;

const onlyManagers = () => new XodoError("Só owner ou admin podem fixar notas ou excluir de vez.", 403);

/** Tira da query string os campos vazios ("?topico=&q=" vale como sem filtro). */
function compact(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== "" && v !== null && v !== undefined));
}

/** Hoje no fuso do xodó (fuso inválido: o dia em UTC). */
function todayOf(xodo: Pick<Xodo, "timezone">, now: Date): string {
  try {
    return dayIn(xodo.timezone, now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function assertNotPast(xodo: Xodo, validUntil: string | null | undefined, now: Date) {
  if (validUntil && validUntil < todayOf(xodo, now)) throw new XodoError("A validade precisa ser hoje ou uma data futura.");
}

/** O cliente precisa ser da agência e estar no alcance do xodó. */
async function assertClientInScope(sql: Sql, xodo: Xodo, clientId: string) {
  const ok = await one(
    sql,
    `select 1 from clients c
      where c.id = $1 and c.agency_id = $2
        and ($3 = 'all' or exists (select 1 from xodo_clients xc where xc.xodo_id = $4 and xc.client_id = c.id))`,
    [clientId, xodo.agency_id, xodo.client_scope, xodo.id],
  );
  if (!ok) throw new XodoError("Cliente não encontrado ou fora do alcance deste xodó.");
}

/** Os ajustes da memória que a tela mostra (mudam pelo PATCH do xodó). */
export function memorySettings(xodo: Xodo) {
  return {
    memory_enabled: xodo.memory_enabled,
    memory_capture: xodo.memory_capture,
    memory_capture_channels: xodo.memory_capture_channels,
    memory_tidy: xodo.memory_tidy,
    memory_core_chars: num(xodo.memory_core_chars),
    memory_tidied_on: xodo.memory_tidied_on,
  };
}

// ---------------------------------------------------------------------------
// Listar
// ---------------------------------------------------------------------------

const STATUS_FILTERS = ["ativo", "proposto", "substituido", "expirado", "arquivado", "apagado", "arquivo", "todas"] as const;

/** GET /memory?topico=&cliente=&status=&q=&cursor=&limite= */
export const listQuery = z.object({
  /** Slug do tópico, ou "nucleo" para as notas sem tópico e sem cliente. */
  topico: z.string().trim().min(1).max(60).optional(),
  /** Id do cliente, ou "todos" para qualquer nota de cliente. */
  cliente: z.union([z.literal("todos"), z.uuid()]).optional(),
  /** "arquivo" junta arquivadas, vencidas e substituídas. */
  status: z.enum(STATUS_FILTERS).default("ativo"),
  q: z.string().trim().max(200).optional(),
  /** Último #n da página anterior. */
  cursor: z.coerce.number().int().min(0).max(INT_MAX).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(100),
});

export type ListedNote = TeamNote & { client_name: string | null; superseded_by_n: number | null };

const NOTE = `i.id, i.xodo_id, i.agency_id, i.n, i.topic, i.client_id, c.name as client_name, i.kind, i.content, i.source, i.status,
  i.pinned, i.valid_until::text as valid_until, i.superseded_by, s.n as superseded_by_n, i.confidence, i.kept_in_core, i.run_id,
  i.created_by, i.version, i.created_at::text as created_at, i.updated_at::text as updated_at`;

/** Termos da busca da tela: sem acento, só letras e números, cada um como prefixo. */
function teamSearch(q: string): string | null {
  const terms = [...new Set(fold(q.normalize("NFC")).split(/[^a-z0-9]+/).filter((w) => w.length >= 2))].slice(0, 8);
  return terms.length ? terms.map((t) => `${t}:*`).join(" & ") : null;
}

/** Notas com filtros, tópicos, medidor do núcleo, contagem por situação e ajustes. */
export async function listMemory(sql: Sql, xodo: Xodo, raw: unknown) {
  const q = listQuery.parse(compact(raw));
  const conditions = ["i.xodo_id = $1", "i.agency_id = $2"];
  const params: unknown[] = [xodo.id, xodo.agency_id];
  const add = (text: string, value: unknown) => {
    params.push(value);
    conditions.push(text.replace("?", `$${params.length}`));
  };
  if (q.status === "arquivo") conditions.push(`i.status in ('arquivado', 'expirado', 'substituido')`);
  else if (q.status !== "todas") add("i.status = ?", q.status);
  if (q.topico === "nucleo") conditions.push("i.topic is null and i.client_id is null");
  else if (q.topico) {
    const slug = slugTopic(q.topico);
    if (!slug) throw new XodoError(`Nome de tópico inválido: "${q.topico}".`);
    add("i.topic = ?", slug);
  }
  if (q.cliente === "todos") conditions.push("i.client_id is not null");
  else if (q.cliente) add("i.client_id = ?::uuid", q.cliente);
  const search = q.q ? teamSearch(q.q) : null;
  if (search) add("i.search @@ to_tsquery('portuguese', ?)", search);
  if (q.cursor) add("i.n > ?", q.cursor);
  params.push(q.limite);
  const rows = await sql.query<ListedNote>(
    `select ${NOTE}
       from xodo_memory_items i
       left join clients c on c.id = i.client_id and c.agency_id = i.agency_id
       left join xodo_memory_items s on s.id = i.superseded_by
      where ${conditions.join(" and ")}
      order by i.n limit $${params.length}`,
    params,
  );
  const notas = rows.map((r) => ({
    ...r,
    n: Number(r.n),
    version: Number(r.version),
    confidence: r.confidence === null ? null : num(r.confidence),
    superseded_by_n: r.superseded_by_n === null ? null : Number(r.superseded_by_n),
  }));
  const mx = memXodo(xodo);
  const counts = await sql.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from xodo_memory_items where xodo_id = $1 and agency_id = $2 group by status`,
    [xodo.id, xodo.agency_id],
  );
  return {
    notas,
    proximo: notas.length === q.limite ? notas[notas.length - 1].n : null,
    topicos: await listTopics(sql, mx),
    medidor: await coreUsage(sql, mx, CORE_MAX_NOTES),
    contagem: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    ajustes: memorySettings(xodo),
  };
}

// ---------------------------------------------------------------------------
// Criar, editar, apagar, desfazer
// ---------------------------------------------------------------------------

const kind = z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]);
const date = z.iso.date();

/** Número da nota na rota (/memory/:n). */
export const noteNumber = z.coerce.number().int().positive().max(INT_MAX);

/** POST /memory */
export const noteInput = z.object({
  texto: z.string().trim().min(1).max(2000),
  tipo: kind.default("fato"),
  topico: z.string().trim().max(60).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  cliente_id: z.uuid().nullable().optional(),
  valido_ate: date.nullable().optional(),
  fixada: z.boolean().optional(),
  motivo: z.string().trim().max(200).optional(),
});

/** Nota escrita pela equipe (source "equipe"); fixar pede owner ou admin. */
export async function createNote(sql: Sql, xodo: Xodo, raw: unknown, actor: TeamActor, now = new Date()) {
  const input = noteInput.parse(raw);
  if (input.fixada && !actor.manage) throw onlyManagers();
  if (input.cliente_id) await assertClientInScope(sql, xodo, input.cliente_id);
  assertNotPast(xodo, input.valido_ate, now);
  const mx = memXodo(xodo);
  const r = await addItem(
    sql,
    mx,
    {
      content: input.texto,
      kind: input.tipo,
      topic: input.topico ?? null,
      aliases: input.aliases,
      clientId: input.cliente_id ?? null,
      validUntil: input.valido_ate ?? null,
      source: "equipe",
      pinned: input.fixada ?? false,
    },
    who(actor, input.motivo),
  );
  // A mesma nota esperando aceite (captura num xodó que sempre pergunta): a equipe escrever é aceitar.
  if (!r.created && r.item.status === "proposto") {
    const accepted = await editItem(
      sql,
      mx,
      r.item.n,
      { status: "ativo", pinned: input.fixada, validUntil: input.valido_ate },
      r.item.version,
      who(actor, input.motivo),
    );
    return { nota: teamNote(accepted.item), criada: false, aceita: true, arquivadas: accepted.archived.map(teamNote), segredos_removidos: r.removed, lote: accepted.batch };
  }
  return {
    nota: teamNote(r.item),
    criada: r.created,
    aceita: false,
    arquivadas: r.archived.map(teamNote),
    segredos_removidos: r.removed,
    lote: r.created ? r.batch : null,
  };
}

/** PATCH /memory/:n  (version é obrigatória: a tela manda a que abriu) */
export const notePatch = z.object({
  version: z.number().int().positive().max(INT_MAX),
  texto: z.string().trim().min(1).max(2000).optional(),
  tipo: kind.optional(),
  topico: z.string().trim().max(60).nullable().optional(),
  cliente_id: z.uuid().nullable().optional(),
  valido_ate: date.nullable().optional(),
  fixada: z.boolean().optional(),
  /** Reativa arquivada, vencida ou apagada, ou aceita a proposta da captura. */
  status: z.literal("ativo").optional(),
  motivo: z.string().trim().max(200).optional(),
});

/** Edita com controle de versão (MemoryConflict vira 409 com a versão atual). */
export async function editNote(sql: Sql, xodo: Xodo, n: number, raw: unknown, actor: TeamActor, now = new Date()) {
  const input = notePatch.parse(raw);
  const { version, motivo } = input;
  let pinned = input.fixada;
  const reactivates = input.status === "ativo" && input.valido_ate === undefined;
  if ((pinned !== undefined && !actor.manage) || reactivates) {
    // Só vale a foto da versão que a tela abriu; com outra versão, o editItem devolve o 409.
    const current = await one<{ valid_until: string | null; version: number; pinned: boolean }>(
      sql,
      `select valid_until::text as valid_until, version, pinned from xodo_memory_items where xodo_id = $1 and agency_id = $2 and n = $3`,
      [xodo.id, xodo.agency_id, n],
    );
    const same = current !== null && Number(current.version) === version;
    if (pinned !== undefined && !actor.manage) {
      // A tela pode mandar a nota inteira: fixada igual à atual não é fixar nem desafixar.
      if (same && current.pinned === pinned) pinned = undefined;
      else if (same) throw onlyManagers();
    }
    if (reactivates && same && current.valid_until && current.valid_until < todayOf(xodo, now)) {
      // Nota vencida só volta com uma validade nova (ou sem validade); senão venceria de novo na hora.
      throw new XodoError(`A nota venceu em ${current.valid_until}. Mande uma validade nova (valido_ate) ou null para não vencer mais.`);
    }
  }
  const patch = {
    content: input.texto,
    kind: input.tipo,
    topic: input.topico,
    clientId: input.cliente_id,
    validUntil: input.valido_ate,
    pinned,
    status: input.status,
  };
  if (Object.values(patch).every((v) => v === undefined)) throw new XodoError("Nada para mudar.");
  if (input.cliente_id) await assertClientInScope(sql, xodo, input.cliente_id);
  assertNotPast(xodo, input.valido_ate, now);
  const r = await editItem(sql, memXodo(xodo), n, patch, version, who(actor, motivo));
  return { nota: teamNote(r.item), arquivadas: r.archived.map(teamNote), segredos_removidos: r.removed, lote: r.batch };
}

/** DELETE /memory/:n?version=&definitivo=1&motivo= */
export const deleteQuery = z.object({
  version: z.coerce.number().int().positive().max(INT_MAX).optional(),
  definitivo: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  motivo: z.string().trim().max(200).optional(),
});

/** Apaga (fica "apagado" e pode ser desfeito) ou, com definitivo, exclui de vez (LGPD, só owner ou admin). */
export async function deleteNote(
  sql: Sql,
  xodo: Xodo,
  n: number,
  raw: unknown,
  actor: TeamActor,
): Promise<{ n: number; excluida: true } | { nota: TeamNote; lote: string | null }> {
  const q = deleteQuery.parse(compact(raw));
  if (q.definitivo) {
    if (!actor.manage) throw onlyManagers();
    await purgeItem(sql, memXodo(xodo), n, who(actor, q.motivo));
    return { n, excluida: true };
  }
  const r = await forgetItem(sql, memXodo(xodo), n, who(actor, q.motivo), q.version ?? null);
  // Já estava apagada: nada foi para o diário, então não há lote para desfazer.
  const journaled = await one(sql, `select 1 from xodo_memory_changes where xodo_id = $1 and batch = $2 limit 1`, [xodo.id, r.batch]);
  return { nota: teamNote(r.item), lote: journaled ? r.batch : null };
}

/**
 * Desfaz um lote inteiro (o desfazer vira outro lote, que também se desfaz). Lote que fixou ou
 * desafixou alguma nota só owner ou admin desfazem (desfazer também mexeria na fixada).
 */
export async function revertNotes(sql: Sql, xodo: Xodo, rawBatch: string, actor: TeamActor) {
  const batch = z.uuid().parse(rawBatch);
  const info = await one<{ rows: number; notes: number; pins: number }>(
    sql,
    `select count(*)::int as rows,
            count(*) filter (where item_id is not null and (before is not null or after is not null))::int as notes,
            count(*) filter (where before is not null and after is not null
                               and (before->>'pinned') is distinct from (after->>'pinned'))::int as pins
       from xodo_memory_changes where xodo_id = $1 and agency_id = $2 and batch = $3`,
    [xodo.id, xodo.agency_id, batch],
  );
  if (info && Number(info.rows) > 0) {
    if (Number(info.notes) === 0) {
      throw new XodoError("Este lote não mudou nenhuma nota que dê para voltar (edição de tópico ou exclusão definitiva).", 409);
    }
    if (Number(info.pins) > 0 && !actor.manage) throw onlyManagers();
  }
  const r = await revertBatch(sql, memXodo(xodo), batch, who(actor));
  return { lote: r.batch, desfeitas: r.reverted };
}

/** GET /memory/changes?n=&run=&before_id=&limit= */
export const changesQuery = z.object({
  n: z.coerce.number().int().positive().max(INT_MAX).optional(),
  run: z.uuid().optional(),
  before_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Linha do diário como a tela recebe (before/after: foto da nota, ou do tópico quando op é "topico"). */
export type MemoryChange = {
  id: number;
  batch: string;
  op: string;
  actor: string;
  actor_user: string | null;
  run_id: string | null;
  topic: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  reverts: string | null;
  created_at: string;
};

export async function listMemoryChanges(sql: Sql, xodo: Xodo, raw: unknown): Promise<{ mudancas: MemoryChange[]; proximo: number | null }> {
  const q = changesQuery.parse(compact(raw));
  const rows = await listChanges(sql, memXodo(xodo), { n: q.n, runId: q.run, beforeId: q.before_id, limit: q.limit });
  // bigint volta como texto no Postgres; a tela recebe número.
  const mudancas = rows.map((r) => ({ ...(r as Omit<MemoryChange, "id">), id: Number(r.id) }));
  return { mudancas, proximo: mudancas.length === q.limit ? mudancas[mudancas.length - 1].id : null };
}

// ---------------------------------------------------------------------------
// Tópicos
// ---------------------------------------------------------------------------

type TopicRow = { slug: string; title: string; description: string; aliases: string[]; updated_at?: string };

function topicSlugParam(raw: string): string {
  const slug = slugTopic(raw);
  if (!slug) throw new XodoError("Tópico não encontrado.", 404);
  return slug;
}

const cleanText = (text: string, max: number) => redactSecrets(text).text.trim().slice(0, max);

/** Diário da equipe para o que store.ts não cobre (tópico e arquivar as notas de um tópico). */
async function journal(
  tx: Sql,
  xodo: Xodo,
  batch: string,
  actor: TeamActor,
  op: "topico" | "arquivar",
  entry: { itemId: string | null; topic: string; before: unknown; after: unknown; reason: string | null },
) {
  await tx.query(
    `insert into xodo_memory_changes (xodo_id, agency_id, batch, item_id, topic, op, actor, actor_user, before, after, reason)
     values ($1, $2, $3, $4, $5, $6, 'equipe', $7, $8::jsonb, $9::jsonb, $10)`,
    [xodo.id, xodo.agency_id, batch, entry.itemId, entry.topic, op, actor.userId,
      entry.before === null ? null : json(entry.before), entry.after === null ? null : json(entry.after),
      entry.reason ? cleanText(entry.reason, 200) : null],
  );
}

/** PUT /memory/topics/:slug  (os apelidos enviados substituem os de antes) */
export const topicPatch = z.object({
  titulo: z.string().trim().min(1).max(80).optional(),
  descricao: z.string().trim().max(300).optional(),
  aliases: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

/** Muda título, descrição e apelidos do tópico (e a busca das notas dele acompanha). */
export async function updateTopic(sql: Sql, xodo: Xodo, rawSlug: string, raw: unknown, actor: TeamActor) {
  const input = topicPatch.parse(raw);
  if (input.titulo === undefined && input.descricao === undefined && input.aliases === undefined) throw new XodoError("Nada para mudar.");
  const slug = topicSlugParam(rawSlug);
  const batch = randomUUID();
  return withMemoryLock(sql, xodo.id, async (tx) => {
    const before = await one<TopicRow>(
      tx,
      `select slug, title, description, aliases from xodo_memory_topics where xodo_id = $1 and agency_id = $2 and slug = $3 for update`,
      [xodo.id, xodo.agency_id, slug],
    );
    if (!before) throw new XodoError("Tópico não encontrado.", 404);
    const title = input.titulo !== undefined ? cleanText(input.titulo, 80) : before.title;
    if (!title) throw new XodoError("O título ficou vazio.");
    const description = input.descricao !== undefined ? cleanText(input.descricao, 300) : before.description;
    const aliases =
      input.aliases !== undefined ? [...new Set(input.aliases.map((a) => cleanText(a, 40)).filter(Boolean))].slice(0, 12) : before.aliases;
    const after = await one<TopicRow>(
      tx,
      `update xodo_memory_topics set title = $4, description = $5, aliases = $6::text[], updated_at = now()
        where xodo_id = $1 and agency_id = $2 and slug = $3
        returning slug, title, description, aliases, updated_at::text as updated_at`,
      [xodo.id, xodo.agency_id, slug, title, description, aliases],
    );
    // Igual ao searchExtra de store.ts: título, apelidos e nome do cliente.
    await tx.query(
      `update xodo_memory_items i
          set search_extra = left(array_to_string(array[$4::text] || $5::text[]
                || array[(select c.name from clients c where c.id = i.client_id and c.agency_id = i.agency_id)], ' '), 1000)
        where i.xodo_id = $1 and i.agency_id = $2 and i.topic = $3`,
      [xodo.id, xodo.agency_id, slug, title, aliases],
    );
    const snap = (t: TopicRow) => ({ slug: t.slug, title: t.title, description: t.description, aliases: t.aliases });
    await journal(tx, xodo, batch, actor, "topico", { itemId: null, topic: slug, before: snap(before), after: snap(after!), reason: "tópico editado pela equipe" });
    return { topico: after! };
  });
}

// Mesmo formato de store.ts, para o revertBatch desfazer o arquivamento.
const ITEM = `id, xodo_id, agency_id, n, topic, client_id, kind, content, identity, source, status, pinned,
  valid_until::text as valid_until, superseded_by, confidence, kept_in_core, run_id, created_by, version,
  created_at::text as created_at, updated_at::text as updated_at`;

function snapshot(item: MemoryItem) {
  return {
    n: Number(item.n),
    topic: item.topic,
    client_id: item.client_id,
    kind: item.kind,
    content: item.content,
    source: item.source,
    status: item.status,
    pinned: item.pinned,
    valid_until: item.valid_until,
    superseded_by: item.superseded_by,
    version: Number(item.version),
  };
}

/**
 * Apagar um tópico arquiva as notas ativas e propostas dele, num lote só (dá para desfazer).
 * O tópico fica enquanto alguma nota apontar para ele; sem nenhuma, sai de vez.
 */
export async function deleteTopic(sql: Sql, xodo: Xodo, rawSlug: string, actor: TeamActor, reason?: string | null) {
  const slug = topicSlugParam(rawSlug);
  const batch = randomUUID();
  const why = reason?.trim() ? reason : "tópico apagado pela equipe";
  return withMemoryLock(sql, xodo.id, async (tx) => {
    const topic = await one<TopicRow>(
      tx,
      `select slug, title, description, aliases from xodo_memory_topics where xodo_id = $1 and agency_id = $2 and slug = $3 for update`,
      [xodo.id, xodo.agency_id, slug],
    );
    if (!topic) throw new XodoError("Tópico não encontrado.", 404);
    const live = await tx.query<MemoryItem>(
      `select ${ITEM} from xodo_memory_items
        where xodo_id = $1 and agency_id = $2 and topic = $3 and status in ('ativo', 'proposto') order by n`,
      [xodo.id, xodo.agency_id, slug],
    );
    for (const before of live) {
      const after = await one<MemoryItem>(
        tx,
        `update xodo_memory_items set status = 'arquivado', version = version + 1, updated_at = now() where id = $1 returning ${ITEM}`,
        [before.id],
      );
      await journal(tx, xodo, batch, actor, "arquivar", { itemId: before.id, topic: slug, before: snapshot(before), after: snapshot(after!), reason: why });
    }
    const gone = await tx.query(
      `delete from xodo_memory_topics t
        where t.xodo_id = $1 and t.agency_id = $2 and t.slug = $3
          and not exists (select 1 from xodo_memory_items i where i.xodo_id = t.xodo_id and i.topic = t.slug)
        returning slug`,
      [xodo.id, xodo.agency_id, slug],
    );
    await journal(tx, xodo, batch, actor, "topico", {
      itemId: null,
      topic: slug,
      before: { slug: topic.slug, title: topic.title, description: topic.description, aliases: topic.aliases },
      after: null,
      reason: why,
    });
    return { topico: slug, arquivadas: live.map((i) => Number(i.n)), removido: gone.length > 0, lote: live.length ? batch : null };
  });
}

// ---------------------------------------------------------------------------
// Capturas e exportação
// ---------------------------------------------------------------------------

/** GET /memory/captures?status=&antes=&limite= */
export const capturesQuery = z.object({
  status: z.enum(["pendente", "rodando", "feito", "pulado", "falhou"]).optional(),
  /** created_at da última captura da página anterior. */
  antes: z.iso.datetime({ offset: true }).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(30),
});

type CaptureRow = {
  id: string;
  conversation_id: string | null;
  status: string;
  turns: number;
  attempts: number;
  last_run_id: string | null;
  due_at: Date | string;
  created_at: Date | string;
  /** created_at com microssegundos, para a próxima página não pular nenhuma captura. */
  cursor: string;
  finished_at: Date | string | null;
  result: unknown;
  error: string | null;
  calls: number;
  cost_usd: string | number | null;
  cost_brl: string | number | null;
};

type CaptureResult = {
  propostos?: number;
  gravados?: number;
  descartados?: { texto: string; motivo: string }[];
  notas?: number[];
  status_notas?: string;
  lote?: string | null;
  motivo?: string;
  adiamentos?: number;
};

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/**
 * O que a captura propôs, gravou e descartou, com o custo de cada uma. O gasto vem de ai_usage
 * com purpose "captura"; o call_id começa com "captura:<id>:" (é a chave que capture.ts usa).
 */
export async function listCaptures(sql: Sql, xodo: Xodo, raw: unknown) {
  const q = capturesQuery.parse(compact(raw));
  const conditions = ["c.xodo_id = $1", "c.agency_id = $2"];
  const params: unknown[] = [xodo.id, xodo.agency_id];
  if (q.status) {
    params.push(q.status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (q.antes) {
    params.push(q.antes);
    conditions.push(`c.created_at < $${params.length}::timestamptz`);
  }
  params.push(q.limite);
  const rows = await sql.query<CaptureRow>(
    `select c.id, c.conversation_id, c.status, c.turns, c.attempts, c.last_run_id, c.due_at, c.created_at, c.finished_at,
            to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor,
            c.result, c.error, coalesce(u.calls, 0) as calls, u.cost_usd, u.cost_brl
       from xodo_memory_captures c
       left join lateral (
         -- O dia da chamada fica entre a criação e o fim da captura (±1 dia por causa do fuso):
         -- assim o índice (agency_id, day) corta o livro de gastos, que só cresce.
         select count(*)::int as calls, sum(a.cost_usd) as cost_usd, sum(a.cost_brl) as cost_brl
           from ai_usage a
          where a.agency_id = c.agency_id
            and a.day between (c.created_at at time zone 'UTC')::date - 1
                          and (coalesce(c.finished_at, now()) at time zone 'UTC')::date + 1
            and a.xodo_id = c.xodo_id and a.purpose = 'captura'
            and a.call_id like 'captura:' || c.id::text || ':%'
       ) u on true
      where ${conditions.join(" and ")}
      order by c.created_at desc, c.id
      limit $${params.length}`,
    params,
  );
  const capturas = rows.map((r) => {
    const result = parseJson<CaptureResult | null>(r.result) ?? {};
    return {
      id: r.id,
      conversation_id: r.conversation_id,
      status: r.status,
      turns: Number(r.turns),
      attempts: Number(r.attempts),
      last_run_id: r.last_run_id,
      due_at: iso(r.due_at),
      created_at: iso(r.created_at),
      finished_at: iso(r.finished_at),
      propostos: num(result.propostos),
      gravados: num(result.gravados),
      status_notas: result.status_notas ?? null,
      notas: result.notas ?? [],
      lote: result.lote ?? null,
      // O texto descartado já vem limpo da captura; limpar de novo não custa e protege a tela.
      descartados: (result.descartados ?? []).map((d) => ({
        texto: redactSecrets(String(d.texto ?? "")).text,
        motivo: redactSecrets(String(d.motivo ?? "")).text,
      })),
      motivo: result.motivo ? redactSecrets(result.motivo).text : null,
      adiamentos: num(result.adiamentos),
      // O erro pode trazer o texto que o provedor devolveu.
      erro: r.error === null ? null : redactSecrets(r.error).text,
      chamadas: Number(r.calls),
      custo_usd: num(r.cost_usd),
      // Sem cotação do dólar na hora, o custo em reais fica nulo.
      custo_brl: r.cost_brl === null ? null : num(r.cost_brl),
    };
  });
  return { capturas, proximo: rows.length === q.limite ? rows[rows.length - 1].cursor : null };
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

/**
 * Notas ativas em markdown, uma por linha: "- AAAA-MM-DD · origem · texto · até AAAA-MM-DD".
 * Núcleo primeiro, depois as de cliente e as de cada tópico.
 */
export async function exportMarkdown(sql: Sql, xodo: Xodo, now = new Date()): Promise<{ filename: string; markdown: string }> {
  const rows = await sql.query<{
    topic: string | null;
    topic_title: string | null;
    client_name: string | null;
    content: string;
    source: string;
    valid_until: string | null;
    updated_at: Date | string;
  }>(
    `select i.topic, t.title as topic_title, c.name as client_name, i.content, i.source, i.valid_until::text as valid_until, i.updated_at
       from xodo_memory_items i
       left join xodo_memory_topics t on t.xodo_id = i.xodo_id and t.slug = i.topic
       left join clients c on c.id = i.client_id and c.agency_id = i.agency_id
      where i.xodo_id = $1 and i.agency_id = $2 and i.status = 'ativo'
      order by case when i.topic is null and i.client_id is null then 0 when i.topic is null then 1 else 2 end,
               c.name, i.topic, i.n`,
    [xodo.id, xodo.agency_id],
  );
  const sections = new Map<string, string[]>();
  for (const r of rows) {
    const title = r.topic
      ? `Tópico: ${oneLine(r.topic_title ?? r.topic)} (${r.topic})`
      : r.client_name
        ? `Cliente: ${oneLine(r.client_name)}`
        : "Núcleo";
    const parts = [todayOf(xodo, new Date(r.updated_at)), r.source, oneLine(r.content)];
    if (r.valid_until) parts.push(`até ${r.valid_until}`);
    const lines = sections.get(title) ?? [];
    lines.push(`- ${parts.join(" · ")}`);
    sections.set(title, lines);
  }
  const today = todayOf(xodo, now);
  const out = [`# Memória de ${oneLine(xodo.name)}`, "", `Exportada em ${today} · ${rows.length} ${rows.length === 1 ? "nota ativa" : "notas ativas"}.`];
  for (const [title, lines] of sections) out.push("", `## ${title}`, "", ...lines);
  return { filename: `memoria-${slugTopic(xodo.name) ?? "xodo"}-${today}.md`, markdown: `${out.join("\n")}\n` };
}
