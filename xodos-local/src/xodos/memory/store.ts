import { randomUUID } from "node:crypto";
import { json, num, one, parseJson, type Sql } from "../db";
import { XodoError } from "../errors";
import { redactSecrets } from "../redact";
import {
  factIdentity,
  NOTE_MAX_CHARS,
  SEMPRE_NUCLEO,
  slugTopic,
  stripListMarker,
  TOPIC_MAX_CHARS,
  TOPIC_MAX_NOTES,
  type MemoryActor,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
} from "./entries";

/**
 * Onde as notas de memória são gravadas (adaptado de server/workspace.ts e memory-journal.ts do
 * OpenMausBot, Apache-2.0). Toda escrita passa por aqui, numa transação com a trava do xodó:
 *  - tira dados sensíveis antes de qualquer coisa (o limite de 1000 caracteres vale depois disso);
 *  - não duplica o mesmo fato (identidade) no mesmo lugar;
 *  - confere a versão da nota quando a equipe edita (409 com a versão atual);
 *  - grava no diário a foto de antes e de depois, num lote que se desfaz junto;
 *  - quando o núcleo passa do limite, arquiva as notas mais antigas (nunca as fixadas, as da
 *    equipe, as de saúde/restrição/compliance nem a que acabou de entrar).
 */

export type MemoryXodo = { id: string; agency_id: string; memory_core_chars: number | string };

export type MemoryItem = {
  id: string;
  xodo_id: string;
  agency_id: string;
  n: number;
  topic: string | null;
  client_id: string | null;
  kind: MemoryKind;
  content: string;
  identity: string;
  source: MemorySource;
  status: MemoryStatus;
  pinned: boolean;
  valid_until: string | null;
  superseded_by: string | null;
  confidence: number | null;
  kept_in_core: boolean;
  run_id: string | null;
  created_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

/** Quem mexeu, para o diário. */
export type Who = { actor: MemoryActor; userId?: string | null; runId?: string | null; reason?: string | null };

export class MemoryConflict extends XodoError {
  constructor(readonly current: MemoryItem) {
    super("A nota mudou desde que você abriu. Veja a versão atual e tente de novo.", 409);
  }
}

const ITEM = `id, xodo_id, agency_id, n, topic, client_id, kind, content, identity, source, status, pinned,
  valid_until::text as valid_until, superseded_by, confidence, kept_in_core, run_id, created_by, version,
  created_at::text as created_at, updated_at::text as updated_at`;

const NIL = "00000000-0000-0000-0000-000000000000";

function normalizeItem(row: MemoryItem): MemoryItem {
  return { ...row, n: Number(row.n), version: Number(row.version), confidence: row.confidence === null ? null : num(row.confidence) };
}

/** Transação com a trava da memória do xodó (gravações ao mesmo tempo esperam a vez). */
export async function withMemoryLock<T>(sql: Sql, xodoId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`xodo_memory:${xodoId}`]);
    return fn(tx);
  });
}

/** Foto da nota para o diário (sem o índice de busca). */
function snapshot(item: MemoryItem) {
  return {
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
    version: item.version,
  };
}

type Op =
  | "criar"
  | "editar"
  | "substituir"
  | "apagar"
  | "expirar"
  | "arquivar"
  | "mover"
  | "fixar"
  | "desfazer"
  | "topico"
  | "expurgar"
  | "aceitar";

async function journal(
  tx: Sql,
  xodo: MemoryXodo,
  batch: string,
  who: Who,
  op: Op,
  before: MemoryItem | null,
  after: MemoryItem | null,
  extra: { topic?: string | null; reverts?: string | null; itemId?: string | null } = {},
) {
  const reason = who.reason ? redactSecrets(who.reason).text.slice(0, 200) : null;
  await tx.query(
    `insert into xodo_memory_changes (xodo_id, agency_id, batch, item_id, topic, op, actor, actor_user, run_id, before, after, reason, reverts)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)`,
    [xodo.id, xodo.agency_id, batch, extra.itemId !== undefined ? extra.itemId : (after ?? before)?.id ?? null,
      extra.topic !== undefined ? extra.topic : (after ?? before)?.topic ?? null, op, who.actor, who.userId ?? null, who.runId ?? null,
      before ? json(snapshot(before)) : null, after ? json(snapshot(after)) : null, reason, extra.reverts ?? null],
  );
}

/** Texto limpo e dentro do limite, ou erro explicando. */
function cleanContent(raw: string): { text: string; removed: number } {
  const { text, removed } = redactSecrets(stripListMarker(raw).replace(/\s+\n/g, "\n").trim());
  if (!text) throw new XodoError("A nota ficou vazia.");
  if (text.length > NOTE_MAX_CHARS) {
    throw new XodoError(`Nota longa demais depois de tirar dados sensíveis (${text.length}/${NOTE_MAX_CHARS}). Divida em notas menores.`);
  }
  return { text, removed };
}

function topicSlug(topic: string | null | undefined): string | null {
  if (topic === null || topic === undefined || topic === "") return null;
  const slug = slugTopic(topic);
  if (!slug) throw new XodoError(`Nome de tópico inválido: "${topic}".`);
  return slug;
}

const cleanAliases = (aliases: string[] | undefined) =>
  [...new Set((aliases ?? []).map((a) => redactSecrets(a).text.trim().slice(0, 40)).filter(Boolean))].slice(0, 12);

/** Cria ou atualiza o tópico (os apelidos se somam, até 12). */
export async function upsertTopic(
  tx: Sql,
  xodo: MemoryXodo,
  slug: string,
  info: { title?: string | null; description?: string | null; aliases?: string[] } = {},
) {
  const title = info.title ? redactSecrets(info.title).text.trim().slice(0, 80) : null;
  const description = info.description !== undefined && info.description !== null ? redactSecrets(info.description).text.trim().slice(0, 300) : null;
  await tx.query(
    `insert into xodo_memory_topics (xodo_id, agency_id, slug, title, description, aliases)
     values ($1, $2, $3, coalesce($4, $3), coalesce($5, ''), $6::text[])
     on conflict (xodo_id, slug) do update set
       title = coalesce($4, xodo_memory_topics.title),
       description = coalesce($5, xodo_memory_topics.description),
       aliases = (select coalesce(array_agg(distinct a), '{}') from
                   (select unnest(xodo_memory_topics.aliases || $6::text[]) as a limit 12) x),
       updated_at = now()`,
    [xodo.id, xodo.agency_id, slug, title, description, cleanAliases(info.aliases)],
  );
}

/** Título, apelidos do tópico e nome do cliente, para a busca achar a nota por eles. */
async function searchExtra(tx: Sql, xodo: MemoryXodo, topic: string | null, clientId: string | null): Promise<string> {
  const parts: string[] = [];
  if (topic) {
    const t = await one<{ title: string; aliases: string[] }>(tx, `select title, aliases from xodo_memory_topics where xodo_id = $1 and slug = $2`, [
      xodo.id,
      topic,
    ]);
    if (t) parts.push(t.title, ...(t.aliases ?? []));
  }
  if (clientId) {
    const c = await one<{ name: string }>(tx, `select name from clients where id = $1 and agency_id = $2`, [clientId, xodo.agency_id]);
    if (c) parts.push(c.name);
  }
  return parts.join(" ").slice(0, 1000);
}

async function findSame(tx: Sql, xodo: MemoryXodo, topic: string | null, clientId: string | null, identity: string, exceptId?: string) {
  const row = await one<MemoryItem>(
    tx,
    `select ${ITEM} from xodo_memory_items
      where xodo_id = $1 and coalesce(client_id, '${NIL}') = coalesce($2::uuid, '${NIL}') and coalesce(topic, '') = coalesce($3, '')
        and identity = $4 and status in ('ativo', 'proposto') and id <> coalesce($5::uuid, '${NIL}')`,
    [xodo.id, clientId, topic, identity, exceptId ?? null],
  );
  return row ? normalizeItem(row) : null;
}

async function assertTopicRoom(tx: Sql, xodo: MemoryXodo, topic: string, extraChars: number) {
  const usage = await one<{ notes: string; chars: string }>(
    tx,
    `select count(*) as notes, coalesce(sum(char_length(content)), 0) as chars from xodo_memory_items
      where xodo_id = $1 and topic = $2 and status = 'ativo'`,
    [xodo.id, topic],
  );
  if (num(usage!.notes) >= TOPIC_MAX_NOTES || num(usage!.chars) + extraChars > TOPIC_MAX_CHARS) {
    throw new XodoError(`O tópico "${topic}" está cheio. Resuma ou apague notas antigas dele antes de acrescentar.`);
  }
}

async function loadByN(tx: Sql, xodo: MemoryXodo, n: number): Promise<MemoryItem> {
  const row = await one<MemoryItem>(tx, `select ${ITEM} from xodo_memory_items where xodo_id = $1 and agency_id = $2 and n = $3`, [
    xodo.id,
    xodo.agency_id,
    n,
  ]);
  if (!row) throw new XodoError(`Nota #${n} não encontrada.`, 404);
  return normalizeItem(row);
}

const isCore = (item: Pick<MemoryItem, "topic" | "client_id" | "status">) => item.topic === null && item.client_id === null && item.status === "ativo";

/**
 * Abre espaço no núcleo arquivando as notas mais antigas até caber no limite do xodó. Nunca
 * saem as fixadas, as escritas pela equipe, as de saúde/restrição/compliance e a nota `keepId`.
 */
export async function makeRoom(tx: Sql, xodo: MemoryXodo, keepId: string | null, batch: string, who: Who): Promise<MemoryItem[]> {
  const limit = num(xodo.memory_core_chars);
  const total = await one<{ chars: string }>(
    tx,
    `select coalesce(sum(char_length(content)), 0) as chars from xodo_memory_items
      where xodo_id = $1 and status = 'ativo' and topic is null and client_id is null
        and (valid_until is null or valid_until >= current_date)`,
    [xodo.id],
  );
  let chars = num(total!.chars);
  if (chars <= limit) return [];
  const candidates = (
    await tx.query<MemoryItem>(
      `select ${ITEM} from xodo_memory_items
        where xodo_id = $1 and status = 'ativo' and topic is null and client_id is null
          and not pinned and source <> 'equipe' and id <> coalesce($2::uuid, '${NIL}')
        order by updated_at, n`,
      [xodo.id, keepId],
    )
  ).map(normalizeItem);
  const archived: MemoryItem[] = [];
  for (const c of candidates) {
    if (chars <= limit) break;
    if (SEMPRE_NUCLEO.test(c.content)) continue;
    const row = await one<MemoryItem>(
      tx,
      `update xodo_memory_items set status = 'arquivado', version = version + 1, updated_at = now() where id = $1 returning ${ITEM}`,
      [c.id],
    );
    const after = normalizeItem(row!);
    await journal(tx, xodo, batch, { ...who, reason: "núcleo cheio: foi para o arquivo" }, "arquivar", c, after);
    archived.push(after);
    chars -= c.content.length;
  }
  return archived;
}

export type AddInput = {
  content: string;
  kind?: MemoryKind;
  topic?: string | null;
  topicTitle?: string | null;
  aliases?: string[];
  clientId?: string | null;
  validUntil?: string | null;
  source: MemorySource;
  status?: "ativo" | "proposto";
  pinned?: boolean;
  confidence?: number | null;
};

export type AddResult = { item: MemoryItem; created: boolean; archived: MemoryItem[]; removed: number; batch: string };

/** Acrescenta uma nota dentro de uma transação que já tem a trava (use addItem fora dela). */
export async function addItemLocked(tx: Sql, xodo: MemoryXodo, input: AddInput, who: Who, batch: string): Promise<AddResult> {
  const { text, removed } = cleanContent(input.content);
  const topic = topicSlug(input.topic);
  const clientId = input.clientId ?? null;
  const identity = factIdentity(text);
  const same = await findSame(tx, xodo, topic, clientId, identity);
  if (same) return { item: same, created: false, archived: [], removed, batch };
  if (topic) {
    // O nome como veio ("Black Friday Acme") vira o título; um slug puro não muda o título que já existe.
    const title = input.topicTitle ?? (input.topic && input.topic !== topic ? input.topic : null);
    await upsertTopic(tx, xodo, topic, { title, aliases: input.aliases });
    await assertTopicRoom(tx, xodo, topic, text.length);
  }
  const extra = await searchExtra(tx, xodo, topic, clientId);
  const row = await one<MemoryItem>(
    tx,
    `insert into xodo_memory_items
       (xodo_id, agency_id, n, topic, client_id, kind, content, identity, search_extra, source, status, pinned, valid_until,
        confidence, run_id, created_by)
     values ($1, $2, (select coalesce(max(n), 0) + 1 from xodo_memory_items where xodo_id = $1), $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::date, $13, $14, $15)
     returning ${ITEM}`,
    [xodo.id, xodo.agency_id, topic, clientId, input.kind ?? "fato", text, identity, extra, input.source, input.status ?? "ativo",
      input.pinned ?? false, input.validUntil ?? null, input.confidence ?? null, who.runId ?? null, who.userId ?? null],
  );
  const item = normalizeItem(row!);
  await journal(tx, xodo, batch, who, "criar", null, item);
  const archived = isCore(item) ? await makeRoom(tx, xodo, item.id, batch, who) : [];
  return { item, created: true, archived, removed, batch };
}

export async function addItem(sql: Sql, xodo: MemoryXodo, input: AddInput, who: Who, batch: string = randomUUID()): Promise<AddResult> {
  return withMemoryLock(sql, xodo.id, (tx) => addItemLocked(tx, xodo, input, who, batch));
}

export type EditPatch = {
  content?: string;
  kind?: MemoryKind;
  topic?: string | null;
  clientId?: string | null;
  validUntil?: string | null;
  pinned?: boolean;
  /** Reativa uma nota arquivada, vencida, apagada ou proposta (aceitar a proposta da captura). */
  status?: "ativo";
};

/** Edita uma nota. Com expectedVersion, recusa (409) se ela mudou desde que foi lida. */
export async function editItem(
  sql: Sql,
  xodo: MemoryXodo,
  n: number,
  patch: EditPatch,
  expectedVersion: number | null,
  who: Who,
): Promise<{ item: MemoryItem; archived: MemoryItem[]; removed: number; batch: string }> {
  const batch = randomUUID();
  return withMemoryLock(sql, xodo.id, async (tx) => {
    const before = await loadByN(tx, xodo, n);
    if (expectedVersion !== null && before.version !== expectedVersion) throw new MemoryConflict(before);
    if (before.status === "substituido") throw new XodoError(`A nota #${n} foi substituída. Edite a nota nova.`, 409);
    let content = before.content;
    let removed = 0;
    if (patch.content !== undefined) ({ text: content, removed } = cleanContent(patch.content));
    const topic = patch.topic !== undefined ? topicSlug(patch.topic) : before.topic;
    const clientId = patch.clientId !== undefined ? patch.clientId : before.client_id;
    const status = patch.status ?? before.status;
    const identity = factIdentity(content);
    if (status === "ativo" || status === "proposto") {
      const same = await findSame(tx, xodo, topic, clientId, identity, before.id);
      if (same) throw new XodoError(`Já existe uma nota igual (#${same.n}).`, 409);
    }
    // Mudou de tópico ou voltou a valer (reativada, proposta aceita): precisa caber no tópico.
    if (topic && (topic !== before.topic || (before.status !== "ativo" && status === "ativo"))) {
      await upsertTopic(tx, xodo, topic);
      await assertTopicRoom(tx, xodo, topic, content.length);
    }
    const extra = await searchExtra(tx, xodo, topic, clientId);
    const row = await one<MemoryItem>(
      tx,
      `update xodo_memory_items set content = $2, identity = $3, topic = $4, client_id = $5, kind = $6, valid_until = $7::date,
              pinned = $8, status = $9, search_extra = $10, kept_in_core = case when $11 then false else kept_in_core end,
              version = version + 1, updated_at = now()
        where id = $1 returning ${ITEM}`,
      [before.id, content, identity, topic, clientId, patch.kind ?? before.kind,
        patch.validUntil !== undefined ? patch.validUntil : before.valid_until, patch.pinned ?? before.pinned, status, extra,
        content !== before.content],
    );
    const item = normalizeItem(row!);
    const op: Op =
      before.status === "proposto" && status === "ativo"
        ? "aceitar"
        : patch.pinned !== undefined && patch.pinned !== before.pinned && content === before.content && topic === before.topic
          ? "fixar"
          : topic !== before.topic && content === before.content
            ? "mover"
            : "editar";
    await journal(tx, xodo, batch, who, op, before, item);
    const archived = isCore(item) ? await makeRoom(tx, xodo, item.id, batch, who) : [];
    return { item, archived, removed, batch };
  });
}

/** Troca uma nota por outra (a antiga fica no histórico como substituída). */
export async function supersedeItem(
  sql: Sql,
  xodo: MemoryXodo,
  n: number,
  input: Omit<AddInput, "source"> & { source?: MemorySource },
  who: Who,
): Promise<{ old: MemoryItem; item: MemoryItem; archived: MemoryItem[]; removed: number; batch: string }> {
  const batch = randomUUID();
  return withMemoryLock(sql, xodo.id, async (tx) => {
    const before = await loadByN(tx, xodo, n);
    if (before.status !== "ativo" && before.status !== "proposto") throw new XodoError(`A nota #${n} não está ativa.`, 409);
    // Primeiro tira a antiga do lugar (a nova pode ter a mesma identidade).
    await tx.query(`update xodo_memory_items set status = 'substituido', version = version + 1, updated_at = now() where id = $1`, [
      before.id,
    ]);
    const added = await addItemLocked(
      tx,
      xodo,
      {
        content: input.content,
        kind: input.kind ?? before.kind,
        topic: input.topic !== undefined ? input.topic : before.topic,
        topicTitle: input.topicTitle,
        aliases: input.aliases,
        clientId: input.clientId !== undefined ? input.clientId : before.client_id,
        validUntil: input.validUntil !== undefined ? input.validUntil : before.valid_until,
        source: input.source ?? before.source,
        status: before.status,
        pinned: before.pinned,
        confidence: input.confidence,
      },
      who,
      batch,
    );
    const old = normalizeItem(
      (await one<MemoryItem>(tx, `update xodo_memory_items set superseded_by = $2 where id = $1 returning ${ITEM}`, [before.id, added.item.id]))!,
    );
    await journal(tx, xodo, batch, who, "substituir", before, old);
    return { old, item: added.item, archived: added.archived, removed: added.removed, batch };
  });
}

/** Esquece uma nota (fica no diário e pode ser desfeita). */
export async function forgetItem(sql: Sql, xodo: MemoryXodo, n: number, who: Who, expectedVersion: number | null = null) {
  const batch = randomUUID();
  return withMemoryLock(sql, xodo.id, async (tx) => {
    const before = await loadByN(tx, xodo, n);
    if (expectedVersion !== null && before.version !== expectedVersion) throw new MemoryConflict(before);
    if (before.status === "apagado") return { item: before, batch };
    const row = await one<MemoryItem>(
      tx,
      `update xodo_memory_items set status = 'apagado', version = version + 1, updated_at = now() where id = $1 returning ${ITEM}`,
      [before.id],
    );
    const item = normalizeItem(row!);
    await journal(tx, xodo, batch, who, "apagar", before, item);
    return { item, batch };
  });
}

/** Exclusão definitiva (LGPD): some a nota e o texto dela no diário. Não dá para desfazer. */
export async function purgeItem(sql: Sql, xodo: MemoryXodo, n: number, who: Who) {
  const batch = randomUUID();
  await withMemoryLock(sql, xodo.id, async (tx) => {
    const before = await loadByN(tx, xodo, n);
    await tx.query(`update xodo_memory_changes set before = null, after = null where item_id = $1`, [before.id]);
    await tx.query(`update xodo_memory_items set superseded_by = null where superseded_by = $1`, [before.id]);
    await tx.query(`delete from xodo_memory_items where id = $1`, [before.id]);
    await journal(tx, xodo, batch, who, "expurgar", null, null, { itemId: null, topic: before.topic });
  });
}

type ChangeRow = {
  id: string;
  item_id: string | null;
  op: Op;
  before: unknown;
  after: unknown;
};

type Snap = ReturnType<typeof snapshot>;

/**
 * Desfaz um lote inteiro, do fim para o começo. Cada nota precisa estar como o lote a deixou
 * (senão 409 com as notas que mudaram depois). O desfazer vira um lote novo, que também se desfaz.
 */
export async function revertBatch(sql: Sql, xodo: MemoryXodo, batch: string, who: Who): Promise<{ batch: string; reverted: number }> {
  const next = randomUUID();
  return withMemoryLock(sql, xodo.id, async (tx) => {
    const changes = await tx.query<ChangeRow>(
      `select id, item_id, op, before, after from xodo_memory_changes where xodo_id = $1 and agency_id = $2 and batch = $3 order by id desc`,
      [xodo.id, xodo.agency_id, batch],
    );
    if (!changes.length) throw new XodoError("Lote não encontrado.", 404);
    const items = changes.filter((c) => c.item_id && (c.after || c.before));
    // Confere antes de mexer: a última foto de cada nota no lote precisa ser a versão atual.
    const lastAfter = new Map<string, Snap | null>();
    for (const c of [...items].reverse()) lastAfter.set(c.item_id!, parseJson<Snap>(c.after));
    const changed: number[] = [];
    for (const [id, after] of lastAfter) {
      const current = await one<{ n: number; version: number }>(tx, `select n, version from xodo_memory_items where id = $1`, [id]);
      if (!current || (after && Number(current.version) !== after.version)) changed.push(Number(current?.n ?? after?.n ?? 0));
    }
    if (changed.length) throw new XodoError(`Não dá para desfazer: ${changed.map((n) => `#${n}`).join(", ")} mudou depois.`, 409);

    // Para cada nota, o alvo é como ela estava antes da primeira mudança do lote (criada pelo
    // lote: volta a não existir, como apagada, para o desfazer também se desfazer).
    const firstBefore = new Map<string, Snap | null>();
    for (const c of [...items].reverse()) if (!firstBefore.has(c.item_id!)) firstBefore.set(c.item_id!, parseJson<Snap>(c.before));
    const plan: { current: MemoryItem; target: Snap }[] = [];
    for (const [id, before] of firstBefore) {
      const current = normalizeItem((await one<MemoryItem>(tx, `select ${ITEM} from xodo_memory_items where id = $1`, [id]))!);
      plan.push({ current, target: before ?? { ...snapshot(current), status: "apagado" } });
    }
    // Primeiro o que sai de cena, depois o que volta (assim uma nota trocada por outra igual não colide).
    const live = (s: string) => s === "ativo" || s === "proposto";
    plan.sort((a, b) => Number(live(a.target.status)) - Number(live(b.target.status)));
    let reverted = 0;
    for (const { current, target } of plan) {
      if (target.topic) await upsertTopic(tx, xodo, target.topic);
      const identity = factIdentity(target.content);
      if (live(target.status)) {
        const same = await findSame(tx, xodo, target.topic, target.client_id, identity, current.id);
        if (same) throw new XodoError(`Não dá para desfazer: já existe uma nota igual ativa (#${same.n}).`, 409);
      }
      const row = await one<MemoryItem>(
        tx,
        `update xodo_memory_items set content = $2, identity = $3, topic = $4, client_id = $5, kind = $6, status = $7, pinned = $8,
                valid_until = $9::date, superseded_by = $10, version = version + 1, updated_at = now()
          where id = $1 returning ${ITEM}`,
        [current.id, target.content, identity, target.topic, target.client_id, target.kind, target.status, target.pinned,
          target.valid_until, target.superseded_by],
      );
      await journal(tx, xodo, next, who, "desfazer", current, normalizeItem(row!), { reverts: batch });
      reverted += 1;
    }
    return { batch: next, reverted };
  });
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export type ListFilters = {
  status?: MemoryStatus | "todas";
  topic?: string | null;
  clientId?: string | null;
  q?: string;
  limit?: number;
  afterN?: number;
};

/** Notas para a equipe (e para a busca do xodó), sem o campo de identidade. */
export async function listItems(sql: Sql, xodo: MemoryXodo, filters: ListFilters = {}): Promise<MemoryItem[]> {
  const conditions = ["xodo_id = $1", "agency_id = $2"];
  const params: unknown[] = [xodo.id, xodo.agency_id];
  const add = (sqlText: string, value: unknown) => {
    params.push(value);
    conditions.push(sqlText.replace("?", `$${params.length}`));
  };
  if (filters.status !== "todas") add("status = ?", filters.status ?? "ativo");
  if (filters.topic === null) conditions.push("topic is null");
  else if (filters.topic) add("topic = ?", filters.topic);
  if (filters.clientId) add("client_id = ?::uuid", filters.clientId);
  if (filters.q?.trim()) add("search @@ plainto_tsquery('portuguese', public.xodo_fold(?))", filters.q.trim().slice(0, 200));
  if (filters.afterN) add("n > ?", filters.afterN);
  params.push(Math.min(filters.limit ?? 100, 500));
  const rows = await sql.query<MemoryItem>(
    `select ${ITEM} from xodo_memory_items where ${conditions.join(" and ")} order by n limit $${params.length}`,
    params,
  );
  return rows.map(normalizeItem);
}

export async function listTopics(sql: Sql, xodo: MemoryXodo) {
  return sql.query<{ slug: string; title: string; description: string; aliases: string[]; notes: number; updated_at: string }>(
    `select t.slug, t.title, t.description, t.aliases, t.updated_at::text as updated_at,
            (select count(*)::int from xodo_memory_items i where i.xodo_id = t.xodo_id and i.topic = t.slug and i.status = 'ativo') as notes
       from xodo_memory_topics t where t.xodo_id = $1 and t.agency_id = $2 order by t.slug`,
    [xodo.id, xodo.agency_id],
  );
}

export async function listChanges(
  sql: Sql,
  xodo: MemoryXodo,
  filters: { n?: number; runId?: string; beforeId?: number; limit?: number } = {},
) {
  const conditions = ["c.xodo_id = $1", "c.agency_id = $2"];
  const params: unknown[] = [xodo.id, xodo.agency_id];
  if (filters.n) {
    params.push(filters.n);
    conditions.push(`c.item_id = (select id from xodo_memory_items where xodo_id = $1 and n = $${params.length})`);
  }
  if (filters.runId) {
    params.push(filters.runId);
    conditions.push(`c.run_id = $${params.length}`);
  }
  if (filters.beforeId) {
    params.push(filters.beforeId);
    conditions.push(`c.id < $${params.length}`);
  }
  params.push(Math.min(filters.limit ?? 50, 100));
  return sql.query(
    `select c.id, c.batch, c.op, c.actor, c.actor_user, c.run_id, c.topic, c.before, c.after, c.reason, c.reverts,
            c.created_at::text as created_at
       from xodo_memory_changes c where ${conditions.join(" and ")} order by c.id desc limit $${params.length}`,
    params,
  );
}

/** Quanto do núcleo está ocupado e se alguma nota fica de fora do prompt. */
export async function coreUsage(sql: Sql, xodo: MemoryXodo, maxNotes = 80) {
  const row = await one<{ chars: string; notes: string }>(
    sql,
    `select coalesce(sum(char_length(content)), 0) as chars, count(*) as notes from xodo_memory_items
      where xodo_id = $1 and status = 'ativo' and topic is null and client_id is null
        and (valid_until is null or valid_until >= current_date)`,
    [xodo.id],
  );
  const chars = num(row!.chars);
  const notes = num(row!.notes);
  const limit = num(xodo.memory_core_chars);
  return { nucleo_chars: chars, limite: limit, notas: notes, fora_do_prompt: chars > limit || notes > maxNotes };
}
