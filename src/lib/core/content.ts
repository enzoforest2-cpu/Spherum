import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { cancelApproval, createApproval, sendMessage, type CollabDeps } from "./collab";

/**
 * Conteúdo e Publicar: posts dos clientes num calendário. O caminho comum é rascunho → aprovação do
 * cliente pelo portal (client_approvals) → aprovado → na fila → publicado. A agência pode pular a
 * aprovação e agendar direto. Com "publicar sozinho quando aprovado", o aprovado já entra na fila.
 * A publicação (Instagram e Facebook, pela API da Meta) roda no cron, na hora marcada.
 */

export const NETS = ["IG", "FB"] as const;
export const KINDS = ["post", "carrossel", "reels", "story"] as const;
const NET_NAME: Record<string, string> = { IG: "Instagram", FB: "Facebook" };
const KIND_NAME: Record<string, string> = { post: "Post", carrossel: "Carrossel", reels: "Reels", story: "Story" };
const TZ = "America/Sao_Paulo";
const MAX_ATTEMPTS = 3;

export type Media = { id: string; url: string; mime: string };
export type PublishArgs = { agencyId: string; connectionId: string; pageId: string; igUserId: string | null; net: "IG" | "FB"; kind: string; caption: string; media: Media[] };
export type Publisher = (a: PublishArgs) => Promise<{ id: string; url: string | null }>;
/** URL temporária (pública, assinada) de um arquivo de Documentos, para a Meta baixar. */
export type MediaUrls = (agencyId: string, ids: string[]) => Promise<Media[]>;
export type ContentDeps = { sql: Sql; publish: Publisher; mediaUrls: MediaUrls; collab: CollabDeps };

const when = (d: Date) => d.toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).replace(/\./g, "");

const fields = {
  client_id: z.uuid(),
  title: z.string().trim().min(1).max(120),
  caption: z.string().max(2200).refine((s) => (s.match(/#/g) ?? []).length <= 30, "Use no máximo 30 hashtags."),
  kind: z.enum(KINDS),
  nets: z.array(z.enum(NETS)).min(1).max(2).transform((a) => [...new Set(a)]),
  publish_at: z.iso.datetime({ offset: true }),
  media_ids: z.array(z.uuid()).max(10),
};
export const postInput = z.object(fields).partial().required({ client_id: true, title: true, publish_at: true });
export const postPatch = z.object(fields).omit({ client_id: true }).partial();

type PostRow = { id: string; agency_id: string; client_id: string; title: string; caption: string; kind: string; nets: string[]; publish_at: string; status: string; version: number; media_ids: string[]; approval_id: string | null; attempts: number };

async function postOf(sql: Sql, agencyId: string, id: string) {
  const p = await one<PostRow>(sql, `select id, agency_id, client_id, title, caption, kind, nets, publish_at::text, status, version, media_ids, approval_id, attempts from content_posts where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!p) throw new XodoError("Post não encontrado.", 404);
  return p;
}

async function checkMedia(sql: Sql, agencyId: string, clientId: string, ids: string[] | undefined) {
  if (!ids?.length) return;
  const ok = await sql.query<{ id: string }>(`select id from documents where agency_id = $1 and id = any($2::uuid[]) and status = 'ready' and (client_id = $3 or client_id is null)`, [agencyId, ids, clientId]);
  if (ok.length !== new Set(ids).size) throw new XodoError("Algum arquivo não foi encontrado em Documentos deste cliente.", 400);
}

const comment = (sql: Sql, p: { id: string; agency_id: string }, side: "agencia" | "cliente" | "sistema", text: string, userId: string | null = null) =>
  sql.query(`insert into content_comments (post_id, agency_id, side, author_user, text) values ($1, $2, $3, $4, $5)`, [p.id, p.agency_id, side, userId, text.slice(0, 2000)]);

export async function createPost(sql: Sql, agencyId: string, userId: string, raw: unknown, opts: { schedule?: boolean } = {}) {
  const i = postInput.parse(raw);
  if (!(await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [i.client_id, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
  await checkMedia(sql, agencyId, i.client_id, i.media_ids);
  if (opts.schedule) validateForPublish({ caption: i.caption ?? "", kind: i.kind ?? "post", nets: i.nets ?? ["IG"], media_ids: i.media_ids ?? [] });
  const row = (await one<{ id: string }>(
    sql,
    `insert into content_posts (agency_id, client_id, title, caption, kind, nets, publish_at, media_ids, status, created_by)
     values ($1, $2, $3, $4, $5, $6::text[], $7, $8::uuid[], $9, $10) returning id`,
    [agencyId, i.client_id, i.title, i.caption ?? "", i.kind ?? "post", i.nets ?? ["IG"], i.publish_at, i.media_ids ?? [], opts.schedule ? "sched" : "draft", userId],
  ))!;
  if (opts.schedule) await comment(sql, { id: row.id, agency_id: agencyId }, "sistema", `Agendado sem aprovação do cliente para ${when(new Date(i.publish_at))}.`);
  return row;
}

/** Edita. Mexer na legenda ou nos arquivos de um post aprovado pelo cliente pede aprovação de novo. */
export async function updatePost(sql: Sql, agencyId: string, userId: string, id: string, raw: unknown) {
  const i = postPatch.parse(raw);
  const p = await postOf(sql, agencyId, id);
  if (["publishing", "pub"].includes(p.status)) throw new XodoError("Post publicado não muda mais.", 409);
  if (p.status === "wait" && (i.caption !== undefined || i.media_ids !== undefined)) throw new XodoError("O cliente está vendo esta versão. Use “Subir nova versão”.", 409);
  await checkMedia(sql, agencyId, p.client_id, i.media_ids);
  const sets: string[] = [], vals: unknown[] = [id];
  for (const [k, v] of Object.entries(i)) {
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}${k === "nets" ? "::text[]" : k === "media_ids" ? "::uuid[]" : ""}`);
  }
  const contentChanged = (i.caption !== undefined && i.caption !== p.caption) || (i.media_ids !== undefined && JSON.stringify(i.media_ids) !== JSON.stringify(p.media_ids));
  if (contentChanged && p.approval_id && ["appr", "sched"].includes(p.status)) {
    sets.push(`status = 'draft'`, `approved_at = null`);
    await comment(sql, p, "sistema", "Editado depois da aprovação: precisa ser aprovado de novo.", userId);
  }
  if (sets.length) await sql.query(`update content_posts set ${sets.join(", ")} where id = $1`, vals);
}

export async function deletePost(sql: Sql, agencyId: string, id: string) {
  const p = await postOf(sql, agencyId, id);
  if (p.status === "publishing") throw new XodoError("O post está saindo agora.", 409);
  if (p.approval_id && p.status === "wait") await cancelApproval(sql, agencyId, p.approval_id).catch(() => {});
  await sql.query(`delete from content_posts where id = $1`, [id]);
}

/** Manda (ou manda de novo, como nova versão) para o cliente aprovar no portal. */
export async function sendForApproval(deps: ContentDeps, agencyId: string, userId: string, id: string, opts: { newVersion?: boolean; note?: string } = {}) {
  const { sql } = deps;
  const p = await postOf(sql, agencyId, id);
  if (!["draft", "fix", "appr", "sched", "fail"].includes(p.status) && !(p.status === "wait" && opts.newVersion)) throw new XodoError("Esse post já está com o cliente.", 409);
  if (p.approval_id && p.status === "wait") await cancelApproval(sql, agencyId, p.approval_id).catch(() => {});
  const version = opts.newVersion || p.status === "fix" ? p.version + 1 : p.version;
  const d = new Date(p.publish_at);
  // O portal mostra o arquivo do cliente (o primeiro anexado a ele).
  const doc = p.media_ids.length ? await one<{ id: string }>(sql, `select id from documents where id = any($1::uuid[]) and client_id = $2 and status = 'ready' order by array_position($1::uuid[], id) limit 1`, [p.media_ids, p.client_id]) : null;
  const ap = await createApproval(deps.collab, agencyId, userId, p.client_id, {
    title: `${KIND_NAME[p.kind]} · ${p.title}`.slice(0, 160),
    details: [`${p.nets.map((n) => NET_NAME[n]).join(" e ")} · ${when(d)}${version > 1 ? ` · versão ${version}` : ""}`, "", p.caption || "(sem legenda)", opts.note ? `\nObservação da agência: ${opts.note}` : ""].join("\n").slice(0, 2000),
    document_id: doc?.id,
  });
  await sql.query(`update content_posts set status = 'wait', approval_id = $2, version = $3, approved_at = null, error = null where id = $1`, [id, ap.id, version]);
  await comment(sql, p, "sistema", `Enviado para o cliente aprovar no portal${version > 1 ? ` (versão ${version})` : ""}.`, userId);
  if (opts.note) await comment(sql, p, "agencia", opts.note, userId);
}

/**
 * Decisão do cliente no portal (chamada pelo decideApproval): aprovado vira "aprovado" (ou entra
 * na fila, se a agência publica sozinha); ajuste volta para a agência com o comentário.
 */
export async function onApprovalDecided(sql: Sql, approvalId: string, decision: "aprovado" | "alteracoes", text: string | undefined, userId: string) {
  const p = await one<PostRow & { auto: boolean }>(
    sql,
    `select p.id, p.agency_id, p.status, a.content_auto_publish as auto from content_posts p join agencies a on a.id = p.agency_id where p.approval_id = $1`,
    [approvalId],
  );
  if (!p || p.status !== "wait") return;
  if (decision === "aprovado") {
    await sql.query(`update content_posts set status = $2, approved_at = now() where id = $1`, [p.id, p.auto ? "sched" : "appr"]);
    await comment(sql, p, "cliente", text ? `Aprovado. ${text}` : "Aprovado!", userId);
    if (p.auto) await comment(sql, p, "sistema", "Entrou na fila: sai sozinho no horário marcado.");
  } else {
    await sql.query(`update content_posts set status = 'fix' where id = $1`, [p.id]);
    await comment(sql, p, "cliente", text || "Pediu ajustes.", userId);
  }
}

/** Comentário da agência no post; com collab, vai também para a conversa com o cliente no portal. */
export async function addComment(sql: Sql, agencyId: string, userId: string, id: string, text: string, collab?: CollabDeps) {
  const t = z.string().trim().min(1).max(2000).parse(text);
  const p = await postOf(sql, agencyId, id);
  await comment(sql, p, "agencia", t, userId);
  if (collab) await sendMessage(collab, "agencia", agencyId, p.client_id, userId, { text: `Sobre o post “${p.title}”: ${t}`.slice(0, 4000) });
}

/** Põe na fila para sair sozinho na hora marcada (ou tira da fila). */
export async function schedulePost(sql: Sql, agencyId: string, userId: string, id: string, on: boolean, publishAt?: string) {
  const p = await postOf(sql, agencyId, id);
  if (["publishing", "pub"].includes(p.status)) throw new XodoError("Esse post já saiu.", 409);
  if (!on) {
    if (p.status !== "sched") return;
    await sql.query(`update content_posts set status = $2 where id = $1`, [id, p.approval_id ? "appr" : "draft"]);
    await comment(sql, p, "sistema", "Tirado da fila.", userId);
    return;
  }
  if (p.status === "wait") throw new XodoError("Espere o cliente aprovar (ou agende sem a aprovação depois de cancelar o pedido).", 409);
  validateForPublish(p);
  const at = publishAt ? z.iso.datetime({ offset: true }).parse(publishAt) : p.publish_at;
  await sql.query(`update content_posts set status = 'sched', publish_at = $2, attempts = 0, error = null where id = $1`, [id, at]);
  await comment(sql, p, "sistema", `${p.status === "appr" ? "" : "Sem aprovação do cliente · "}na fila para ${when(new Date(at))}.`, userId);
}

/** Regras da Meta que dá para conferir antes. */
export function validateForPublish(p: { caption: string; kind: string; nets: string[]; media_ids: string[] }) {
  if (p.nets.includes("IG") && !p.media_ids.length) throw new XodoError("O Instagram só publica com foto ou vídeo. Anexe o arquivo do post.", 400);
  if (p.kind === "carrossel" && p.media_ids.length < 2) throw new XodoError("Carrossel precisa de 2 a 10 arquivos.", 400);
  if (["reels", "story"].includes(p.kind) && p.media_ids.length > 1) throw new XodoError(`${KIND_NAME[p.kind]} leva um arquivo só.`, 400);
  if (p.kind === "story" && p.nets.includes("FB")) throw new XodoError("Story só no Instagram.", 400);
  if (!p.caption.trim() && !p.media_ids.length) throw new XodoError("Post vazio: escreva a legenda ou anexe um arquivo.", 400);
}

/** Publica agora (botão) ou pelo cron. Cada rede que já saiu não sai de novo. */
export async function publishPost(deps: ContentDeps, agencyId: string, id: string, now = new Date()) {
  const { sql } = deps;
  // Pega o post para publicar (só um processo por vez); prev_status diz se veio da fila.
  const claimed = await one<PostRow & { prev_status: string; results: Record<string, { id: string; url: string | null }> }>(
    sql,
    `with prev as (select status from content_posts where id = $1 and agency_id = $2)
     update content_posts set status = 'publishing', attempts = attempts + 1 where id = $1 and agency_id = $2 and status in ('appr', 'sched', 'fail', 'draft')
     returning id, agency_id, client_id, title, caption, kind, nets, publish_at::text, status, version, media_ids, approval_id, attempts, results, (select status from prev) as prev_status`,
    [id, agencyId],
  );
  if (!claimed) throw new XodoError("Esse post não pode sair agora (já saiu, está saindo ou está com o cliente).", 409);
  const results = { ...(claimed.results ?? {}) };
  try {
    validateForPublish(claimed);
    const social = await one<{ connection_id: string; page_id: string; ig_user_id: string | null }>(sql, `select connection_id, page_id, ig_user_id from client_social where client_id = $1`, [claimed.client_id]);
    if (!social) throw new XodoError("Ligue o Instagram e o Facebook deste cliente em Publicar.", 400);
    if (claimed.nets.includes("IG") && !social.ig_user_id) throw new XodoError("A página deste cliente não tem Instagram profissional ligado.", 400);
    const media = claimed.media_ids.length ? await deps.mediaUrls(agencyId, claimed.media_ids) : [];
    for (const net of claimed.nets as ("IG" | "FB")[]) {
      if (results[net]) continue;
      results[net] = await deps.publish({ agencyId, connectionId: social.connection_id, pageId: social.page_id, igUserId: social.ig_user_id, net, kind: claimed.kind, caption: claimed.caption, media });
      await sql.query(`update content_posts set results = $2::jsonb where id = $1`, [id, json(results)]);
    }
    await sql.query(`update content_posts set status = 'pub', published_at = $2, error = null where id = $1`, [id, now.toISOString()]);
    await comment(sql, claimed, "sistema", `Publicado no ${claimed.nets.map((n) => NET_NAME[n]).join(" e no ")}.`);
    return { results };
  } catch (error) {
    const msg = (error instanceof Error ? error.message : String(error)).slice(0, 600);
    // Falha passageira no cron tenta de novo no próximo ciclo (até 3 vezes); o resto espera a agência.
    const retry = claimed.prev_status === "sched" && claimed.attempts < MAX_ATTEMPTS && !(error instanceof XodoError) && (error as { status?: number }).status !== 401;
    await sql.query(`update content_posts set status = $2, error = $3 where id = $1`, [id, retry ? "sched" : "fail", msg]);
    if (!retry) {
      await comment(sql, claimed, "sistema", `Não saiu: ${msg}`);
      await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'post_falhou', $2, jsonb_build_object('post_id', $3::text))`, [agencyId, `Post não saiu: ${claimed.title}`.slice(0, 200), id]);
    }
    throw error instanceof XodoError ? error : new XodoError(`Não saiu: ${msg}`, 502);
  }
}

/** Cron: publica o que está na fila e já passou da hora. */
export async function publishSweep(deps: ContentDeps, now = new Date(), opts: { deadline?: number; limit?: number } = {}) {
  const due = await deps.sql.query<{ id: string; agency_id: string }>(
    `select id, agency_id from content_posts where status = 'sched' and publish_at <= $1 order by publish_at limit $2`,
    [now.toISOString(), opts.limit ?? 20],
  );
  const out = { published: 0, failed: 0 };
  for (const p of due) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try { await publishPost(deps, p.agency_id, p.id, now); out.published++; } catch { out.failed++; }
  }
  // Publicação que travou no meio (processo caiu): volta para a fila.
  await deps.sql.query(`update content_posts set status = 'sched' where status = 'publishing' and updated_at < $1::timestamptz - interval '15 minutes'`, [now.toISOString()]);
  return out;
}

/** Marca como publicado à mão (saiu por fora do Spherum). */
export async function markPublished(sql: Sql, agencyId: string, userId: string, id: string, url?: string) {
  const p = await postOf(sql, agencyId, id);
  if (p.status === "pub") return;
  const link = url ? z.url({ protocol: /^https$/ }).max(500).parse(url) : null;
  await sql.query(`update content_posts set status = 'pub', published_at = now(), results = results || $2::jsonb, error = null where id = $1`, [id, json(link ? { manual: { id: "manual", url: link } } : {})]);
  await comment(sql, p, "sistema", "Marcado como publicado pela equipe.", userId);
}

export async function setAutoPublish(sql: Sql, agencyId: string, on: boolean) {
  await sql.query(`update agencies set content_auto_publish = $2 where id = $1`, [agencyId, on]);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export async function contentBoard(sql: Sql, agencyId: string, from: string, to: string) {
  const [posts, comments, social, agency] = await Promise.all([
    sql.query<{ id: string; client_id: string; title: string; caption: string; kind: string; nets: string[]; publish_at: string; status: string; version: number; media_ids: string[]; approval_id: string | null; approved_at: string | null; published_at: string | null; results: Record<string, { id: string; url: string | null }>; error: string | null; updated_at: string }>(
      `select id, client_id, title, caption, kind, nets, publish_at::text, status, version, media_ids, approval_id, approved_at::text, published_at::text, results, error, updated_at::text
         from content_posts where agency_id = $1 and ((publish_at >= $2 and publish_at < $3) or status in ('wait', 'fix', 'fail', 'sched')) order by publish_at limit 1000`,
      [agencyId, from, to],
    ),
    sql.query<{ id: number; post_id: string; side: string; author_name: string | null; text: string; created_at: string }>(
      `select c.id, c.post_id, c.side, coalesce(p.full_name, u.email) as author_name, c.text, c.created_at::text
         from content_comments c left join profiles p on p.id = c.author_user left join auth.users u on u.id = c.author_user
        where c.agency_id = $1 and c.post_id in (select id from content_posts where agency_id = $1 and ((publish_at >= $2 and publish_at < $3) or status in ('wait', 'fix', 'fail', 'sched')))
        order by c.id`,
      [agencyId, from, to],
    ),
    sql.query<{ client_id: string; connection_id: string; page_id: string; page_name: string | null; ig_user_id: string | null; ig_username: string | null; last_error: string | null; status: string }>(
      `select s.client_id, s.connection_id, s.page_id, s.page_name, s.ig_user_id, s.ig_username, s.last_error, c.status
         from client_social s join integration_connections c on c.id = s.connection_id where s.agency_id = $1`,
      [agencyId],
    ),
    one<{ auto: boolean }>(sql, `select content_auto_publish as auto from agencies where id = $1`, [agencyId]),
  ]);
  const approvals = await sql.query<{ approval_id: string; hours: number; first: boolean }>(
    `select p.approval_id, extract(epoch from (p.approved_at - a.created_at)) / 3600 as hours, p.version = 1 as first
       from content_posts p join client_approvals a on a.id = p.approval_id where p.agency_id = $1 and p.approved_at > now() - interval '30 days'`,
    [agencyId],
  );
  return {
    auto_publish: agency?.auto ?? false,
    posts: posts.map((p) => ({ ...p, comments: comments.filter((c) => c.post_id === p.id).map((c) => ({ ...c, id: Number(c.id) })) })),
    social,
    stats: {
      approval_hours: approvals.length ? Math.round(approvals.reduce((t, a) => t + Number(a.hours), 0) / approvals.length) : null,
      first_try_pct: approvals.length ? Math.round((approvals.filter((a) => a.first).length / approvals.length) * 100) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Perfis dos clientes
// ---------------------------------------------------------------------------

export const socialInput = z.object({
  connection_id: z.uuid(),
  page_id: z.string().regex(/^\d{1,40}$/),
  page_name: z.string().max(200).nullable().optional(),
  ig_user_id: z.string().regex(/^\d{1,40}$/).nullable().optional(),
  ig_username: z.string().max(100).nullable().optional(),
});

export async function linkSocial(sql: Sql, agencyId: string, clientId: string, raw: unknown) {
  const i = socialInput.parse(raw);
  if (!(await one(sql, `select 1 from clients where id = $1 and agency_id = $2`, [clientId, agencyId]))) throw new XodoError("Cliente não encontrado.", 404);
  const c = await one<{ provider: string }>(sql, `select provider from integration_connections where id = $1 and agency_id = $2 and status <> 'revoked'`, [i.connection_id, agencyId]);
  if (!c || c.provider !== "meta") throw new XodoError("Escolha uma conexão da Meta.", 400);
  await sql.query(
    `insert into client_social (client_id, agency_id, connection_id, page_id, page_name, ig_user_id, ig_username) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (client_id) do update set connection_id = excluded.connection_id, page_id = excluded.page_id, page_name = excluded.page_name,
       ig_user_id = excluded.ig_user_id, ig_username = excluded.ig_username, last_error = null, updated_at = now()`,
    [clientId, agencyId, i.connection_id, i.page_id, i.page_name ?? null, i.ig_user_id ?? null, i.ig_username ?? null],
  );
}

export async function unlinkSocial(sql: Sql, agencyId: string, clientId: string) {
  await sql.query(`delete from client_social where client_id = $1 and agency_id = $2`, [clientId, agencyId]);
}
