import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import type { Mailer } from "./email";

/**
 * Colaboração entre a agência e o cliente no portal: o que foi feito (atualizações), o que a
 * agência precisa do cliente (pendências), o que o cliente aprova (aprovações) e a conversa.
 * A agência escreve pelos endpoints da equipe; o cliente responde pelos do portal.
 */

export type Side = "agencia" | "cliente";
export type CollabDeps = { sql: Sql; mail?: Mailer; appUrl?: string };

const notifyAgency = (sql: Sql, agencyId: string, kind: string, title: string, data: Record<string, unknown>) =>
  sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, $2, $3, $4::jsonb)`, [agencyId, kind, title.slice(0, 200), json(data)]);

/** E-mail para quem é do cliente (sem bloquear: o registro já foi feito). */
async function mailClient(deps: CollabDeps, clientId: string, subject: string, line: string) {
  if (!deps.mail) return;
  const rows = await deps.sql.query<{ email: string | null; agency: string; client: string }>(
    `select u.email, a.name as agency, c.name as client from client_portal_users p
       join auth.users u on u.id = p.user_id join clients c on c.id = p.client_id join agencies a on a.id = c.agency_id
      where p.client_id = $1`,
    [clientId],
  );
  const to = rows.map((r) => r.email).filter((e): e is string => !!e);
  if (!to.length) return;
  const link = `${(deps.appUrl ?? "https://spherum.com.br").replace(/\/+$/, "")}/cliente`;
  await deps.mail({ to, subject: `${rows[0].agency}: ${subject}`.slice(0, 200), text: `${line}\n\nAbra o portal para ver: ${link}` }).catch(() => false);
}

async function clientOf(sql: Sql, agencyId: string, clientId: string) {
  const c = await one<{ name: string }>(sql, `select name from clients where id = $1 and agency_id = $2 and archived_at is null`, [clientId, agencyId]);
  if (!c) throw new XodoError("Cliente não encontrado.", 404);
  return c;
}

// ---------------------------------------------------------------------------
// Atualizações ("Feito pela agência")
// ---------------------------------------------------------------------------

export const updateInput = z.object({
  kind: z.enum(["otimizacao", "alerta", "relatorio", "equipe"]).default("equipe"),
  title: z.string().trim().min(1).max(200),
  why: z.string().trim().max(600).optional(),
  impact: z.string().trim().max(120).optional(),
  publish: z.boolean().default(true),
});

const UPDATE_COLS = `u.id, u.client_id, u.kind, u.title, u.why, u.impact, u.source, u.status, u.published_at::text, u.created_at::text,
  x.name as xodo_name, p.full_name as author_name`;
const UPDATE_FROM = `from client_updates u left join xodos x on x.id = u.xodo_id left join profiles p on p.id = u.created_by`;

export async function createUpdate(sql: Sql, agencyId: string, userId: string, clientId: string, raw: unknown) {
  const input = updateInput.parse(raw);
  await clientOf(sql, agencyId, clientId);
  return one(
    sql,
    `insert into client_updates (agency_id, client_id, kind, title, why, impact, source, status, published_at, created_by)
     values ($1, $2, $3, $4, $5, $6, 'equipe', $7, case when $7 = 'publicado' then now() end, $8) returning id, status`,
    [agencyId, clientId, input.kind, input.title, input.why ?? null, input.impact ?? null, input.publish ? "publicado" : "rascunho", userId],
  );
}

export async function setUpdateStatus(sql: Sql, agencyId: string, id: string, status: "publicado" | "descartado" | "rascunho", edit?: { title?: string; why?: string | null }) {
  const row = await one(
    sql,
    `update client_updates set status = $3, published_at = case when $3 = 'publicado' then coalesce(published_at, now()) else published_at end,
            title = coalesce($4, title), why = case when $5 then $6 else why end
      where id = $1 and agency_id = $2 returning id`,
    [id, agencyId, status, edit?.title?.trim() || null, edit?.why !== undefined, edit?.why ?? null],
  );
  if (!row) throw new XodoError("Atualização não encontrada.", 404);
}

/**
 * O que um xodó fez numa campanha vira atualização do cliente. Entra como rascunho, a menos que a
 * agência tenha ligado a publicação automática (portal_settings.auto_publicar).
 */
export async function recordActionUpdate(
  sql: Sql,
  o: { agencyId: string; xodoId: string; actionId: string; toolName: string; input: Record<string, unknown>; summary: string },
) {
  const clientId = typeof o.input.client_id === "string" ? o.input.client_id : null;
  if (!clientId) return;
  const meta = await one<{ auto: boolean; campaign: string | null }>(
    sql,
    `select coalesce((a.portal_settings->>'auto_publicar')::boolean, false) as auto,
            (select max(m.campaign_name) from metrics_daily m where m.client_id = $2 and m.campaign_id = $3) as campaign
       from agencies a where a.id = $1`,
    [o.agencyId, clientId, String(o.input.campaign_id ?? "")],
  );
  if (!meta) return;
  const campaign = meta.campaign ?? (o.input.campaign_id ? `campanha ${o.input.campaign_id}` : "campanha");
  const verba = typeof o.input.nova_verba_brl === "number" ? o.input.nova_verba_brl.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/\u00a0/g, " ") : null;
  const title =
    o.toolName === "pausar_campanha"
      ? `Pausamos a campanha ${campaign}`
      : o.toolName === "ativar_campanha"
        ? `Retomamos a campanha ${campaign}`
        : o.toolName === "ajustar_verba_diaria" && verba
          ? `Ajustamos a verba diária de ${campaign} para ${verba}`
          : o.summary.charAt(0).toUpperCase() + o.summary.slice(1);
  await sql.query(
    `insert into client_updates (agency_id, client_id, kind, title, source, xodo_id, action_id, status, published_at)
     select $1, $2, 'otimizacao', $3, 'xodo', $4, $5, $6, case when $6 = 'publicado' then now() end
      where exists (select 1 from clients where id = $2 and agency_id = $1)
     on conflict (action_id) do nothing`,
    [o.agencyId, clientId, title.slice(0, 200), o.xodoId, o.actionId, meta.auto ? "publicado" : "rascunho"],
  );
}

/** Relatório publicado aparece no "Feito pela agência" (uma vez por relatório). */
export async function recordReportUpdate(sql: Sql, reportId: string, xodoId?: string | null) {
  await sql.query(
    `insert into client_updates (agency_id, client_id, kind, title, why, source, xodo_id, report_id, status, published_at)
     select r.agency_id, r.client_id, 'relatorio', 'Publicamos o relatório ' || r.title, 'Está em Relatórios, no portal.',
            case when $2::uuid is null then 'equipe' else 'xodo' end, $2, r.id, 'publicado', now()
       from reports r where r.id = $1 and r.status = 'published'
     on conflict (report_id) do nothing`,
    [reportId, xodoId ?? null],
  );
}

// ---------------------------------------------------------------------------
// Pendências
// ---------------------------------------------------------------------------

export const requestInput = z.object({
  title: z.string().trim().min(1).max(160),
  details: z.string().trim().max(2000).optional(),
  kind: z.enum(["passos", "texto", "arquivo"]).default("texto"),
  steps: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  due_date: z.iso.date().optional(),
});

export async function createRequest(deps: CollabDeps, agencyId: string, userId: string, clientId: string, raw: unknown) {
  const input = requestInput.parse(raw);
  await clientOf(deps.sql, agencyId, clientId);
  const row = await one<{ id: string }>(
    deps.sql,
    `insert into client_requests (agency_id, client_id, title, details, kind, steps, due_date, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [agencyId, clientId, input.title, input.details ?? null, input.kind, input.steps, input.due_date ?? null, userId],
  );
  await mailClient(deps, clientId, `pendência: ${input.title}`, `A agência precisa de você: ${input.title}.${input.details ? `\n\n${input.details}` : ""}`);
  return row!;
}

export async function cancelRequest(sql: Sql, agencyId: string, id: string) {
  const row = await one(sql, `update client_requests set status = 'cancelado' where id = $1 and agency_id = $2 and status = 'aberto' returning id`, [id, agencyId]);
  if (!row) throw new XodoError("Pendência não encontrada ou já resolvida.", 404);
}

export const requestAnswer = z.object({ response: z.string().trim().max(4000).optional(), document_id: z.uuid().optional() });

/** O cliente resolve a pendência: "já fiz", uma resposta escrita ou um arquivo enviado pelo portal. */
export async function answerRequest(sql: Sql, userId: string, id: string, raw: unknown) {
  const input = requestAnswer.parse(raw);
  const req = await one<{ agency_id: string; client_id: string; kind: string; title: string; status: string }>(
    sql,
    `select r.agency_id, r.client_id, r.kind, r.title, r.status from client_requests r
      where r.id = $1 and exists (select 1 from client_portal_users u where u.client_id = r.client_id and u.user_id = $2)`,
    [id, userId],
  );
  if (!req) throw new XodoError("Pendência não encontrada.", 404);
  if (req.status !== "aberto") throw new XodoError("Essa pendência já foi resolvida.", 409);
  if (req.kind === "texto" && !input.response) throw new XodoError("Escreva a resposta.", 400);
  if (req.kind === "arquivo" && !input.document_id) throw new XodoError("Envie o arquivo.", 400);
  if (input.document_id) {
    const doc = await one(sql, `select 1 from documents where id = $1 and client_id = $2 and status = 'ready'`, [input.document_id, req.client_id]);
    if (!doc) throw new XodoError("Arquivo não encontrado.", 404);
  }
  await sql.query(
    `update client_requests set status = 'feito', response = $2, document_id = $3, done_by = $4, done_at = now() where id = $1`,
    [id, input.response ?? null, input.document_id ?? null, userId],
  );
  await notifyAgency(sql, req.agency_id, "pendencia_resolvida", `Pendência resolvida pelo cliente: ${req.title}`, { client_id: req.client_id, request_id: id });
}

// ---------------------------------------------------------------------------
// Aprovações
// ---------------------------------------------------------------------------

export const approvalInput = z.object({
  title: z.string().trim().min(1).max(160),
  details: z.string().trim().max(2000).optional(),
  document_id: z.uuid().optional(),
  link: z.url({ protocol: /^https$/ }).max(1000).optional(),
});

export async function createApproval(deps: CollabDeps, agencyId: string, userId: string, clientId: string, raw: unknown) {
  const input = approvalInput.parse(raw);
  await clientOf(deps.sql, agencyId, clientId);
  if (input.document_id) {
    const doc = await one(deps.sql, `select 1 from documents where id = $1 and agency_id = $2 and client_id = $3 and status = 'ready'`, [input.document_id, agencyId, clientId]);
    if (!doc) throw new XodoError("Documento não encontrado neste cliente.", 404);
    // O cliente precisa ver o arquivo para aprovar.
    await deps.sql.query(`update documents set shared = true where id = $1`, [input.document_id]);
  }
  const row = await one<{ id: string }>(
    deps.sql,
    `insert into client_approvals (agency_id, client_id, title, details, document_id, link, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [agencyId, clientId, input.title, input.details ?? null, input.document_id ?? null, input.link ?? null, userId],
  );
  await mailClient(deps, clientId, `aprovar: ${input.title}`, `A agência mandou para sua aprovação: ${input.title}.`);
  return row!;
}

export async function cancelApproval(sql: Sql, agencyId: string, id: string) {
  const row = await one(sql, `update client_approvals set status = 'cancelado' where id = $1 and agency_id = $2 and status = 'pendente' returning id`, [id, agencyId]);
  if (!row) throw new XodoError("Aprovação não encontrada ou já decidida.", 404);
}

export const approvalDecision = z.object({ decision: z.enum(["aprovado", "alteracoes"]), comment: z.string().trim().max(2000).optional() });

export async function decideApproval(sql: Sql, userId: string, id: string, raw: unknown) {
  const input = approvalDecision.parse(raw);
  if (input.decision === "alteracoes" && !input.comment) throw new XodoError("Conte o que precisa mudar.", 400);
  const ap = await one<{ agency_id: string; client_id: string; title: string; status: string }>(
    sql,
    `select a.agency_id, a.client_id, a.title, a.status from client_approvals a
      where a.id = $1 and exists (select 1 from client_portal_users u where u.client_id = a.client_id and u.user_id = $2)`,
    [id, userId],
  );
  if (!ap) throw new XodoError("Aprovação não encontrada.", 404);
  if (ap.status !== "pendente") throw new XodoError("Essa aprovação já foi decidida.", 409);
  await sql.query(`update client_approvals set status = $2, comment = $3, decided_by = $4, decided_at = now() where id = $1`, [id, input.decision, input.comment ?? null, userId]);
  await notifyAgency(sql, ap.agency_id, input.decision === "aprovado" ? "aprovado_pelo_cliente" : "ajuste_pedido_pelo_cliente",
    `${input.decision === "aprovado" ? "Aprovado" : "Ajustes pedidos"} pelo cliente: ${ap.title}`, { client_id: ap.client_id, approval_id: id });
}

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

export const messageInput = z.object({ text: z.string().trim().min(1).max(4000) });

export async function sendMessage(deps: CollabDeps, side: Side, agencyId: string, clientId: string, userId: string, raw: unknown) {
  const { text } = messageInput.parse(raw);
  const row = await one<{ id: number }>(
    deps.sql,
    `insert into client_messages (agency_id, client_id, side, author_user, text) values ($1, $2, $3, $4, $5) returning id`,
    [agencyId, clientId, side, userId, text],
  );
  await markRead(deps.sql, clientId, side);
  if (side === "cliente") {
    const c = await one<{ name: string }>(deps.sql, `select name from clients where id = $1`, [clientId]);
    await notifyAgency(deps.sql, agencyId, "mensagem_do_cliente", `Mensagem de ${c?.name ?? "cliente"}`, { client_id: clientId, preview: text.slice(0, 140) });
  } else {
    await mailClient(deps, clientId, "nova mensagem", `Nova mensagem da agência:\n\n${text.slice(0, 1000)}`);
  }
  return { id: Number(row!.id) };
}

export async function markRead(sql: Sql, clientId: string, side: Side) {
  await sql.query(
    `insert into client_message_reads (client_id, side, last_read_id)
     values ($1, $2, coalesce((select max(id) from client_messages where client_id = $1), 0))
     on conflict (client_id, side) do update set last_read_id = excluded.last_read_id`,
    [clientId, side],
  );
}

export async function listMessages(sql: Sql, clientId: string, limit = 200) {
  const rows = await sql.query<{ id: number; side: Side; text: string; created_at: string; author_name: string | null }>(
    `select * from (select m.id, m.side, m.text, m.created_at::text, coalesce(p.full_name, u.email) as author_name
       from client_messages m left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
      where m.client_id = $1 order by m.id desc limit $2) t order by id`,
    [clientId, limit],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Mensagens que um lado ainda não leu, por cliente. */
export async function unreadBy(sql: Sql, agencyId: string, side: Side) {
  const rows = await sql.query<{ client_id: string; n: number }>(
    `select m.client_id, count(*)::int as n from client_messages m
       left join client_message_reads r on r.client_id = m.client_id and r.side = $2
      where m.agency_id = $1 and m.side <> $2 and m.id > coalesce(r.last_read_id, 0) group by m.client_id`,
    [agencyId, side],
  );
  return Object.fromEntries(rows.map((r) => [r.client_id, r.n]));
}

// ---------------------------------------------------------------------------
// Leituras
// ---------------------------------------------------------------------------

/** Tudo da colaboração de um cliente. O cliente vê só o publicado e o que não foi cancelado. */
export async function clientCollab(sql: Sql, clientId: string, side: Side) {
  const forClient = side === "cliente";
  const [updates, requests, approvals, messages] = await Promise.all([
    sql.query<{ id: string; client_id: string; kind: string; title: string; why: string | null; impact: string | null; source: string; status: string; published_at: string | null; created_at: string; xodo_name: string | null; author_name: string | null }>(
      `select ${UPDATE_COLS} ${UPDATE_FROM} where u.client_id = $1 and ($2 = false or u.status = 'publicado') and u.status <> 'descartado'
        order by coalesce(u.published_at, u.created_at) desc limit 100`,
      [clientId, forClient],
    ),
    sql.query(
      `select r.id, r.title, r.details, r.kind, r.steps, r.due_date::text, r.status, r.response, r.document_id, r.done_at::text, r.created_at::text
         from client_requests r where r.client_id = $1 and ($2 = false or r.status <> 'cancelado') order by (r.status = 'aberto') desc, r.created_at desc limit 100`,
      [clientId, forClient],
    ),
    sql.query(
      `select a.id, a.title, a.details, a.document_id, d.name as document_name, a.link, a.status, a.comment, a.decided_at::text, a.created_at::text,
              p.full_name as created_by_name
         from client_approvals a left join documents d on d.id = a.document_id left join profiles p on p.id = a.created_by
        where a.client_id = $1 and ($2 = false or a.status <> 'cancelado') order by (a.status = 'pendente') desc, a.created_at desc limit 100`,
      [clientId, forClient],
    ),
    listMessages(sql, clientId),
  ]);
  const read = await one<{ last_read_id: number }>(sql, `select last_read_id from client_message_reads where client_id = $1 and side = $2`, [clientId, side]);
  const lastRead = Number(read?.last_read_id ?? 0);
  return { updates, requests, approvals, messages, unread: messages.filter((m) => m.side !== side && m.id > lastRead).length };
}

/** Números da agência inteira para o painel e o menu. */
export async function agencyCollabSummary(sql: Sql, agencyId: string) {
  const row = await one<{ drafts: number; approvals: number; requests: number; changes: number }>(
    sql,
    `select (select count(*)::int from client_updates where agency_id = $1 and status = 'rascunho') as drafts,
            (select count(*)::int from client_approvals where agency_id = $1 and status = 'pendente') as approvals,
            (select count(*)::int from client_requests where agency_id = $1 and status = 'aberto') as requests,
            (select count(*)::int from client_approvals where agency_id = $1 and status = 'alteracoes' and decided_at > now() - interval '14 days') as changes`,
    [agencyId],
  );
  // Uma linha por conversa: a última mensagem de cada cliente.
  const threads = await sql.query<{ client_id: string; side: Side; text: string; created_at: string; author_name: string | null }>(
    `select distinct on (m.client_id) m.client_id, m.side, m.text, m.created_at::text, coalesce(p.full_name, u.email) as author_name
       from client_messages m left join profiles p on p.id = m.author_user left join auth.users u on u.id = m.author_user
      where m.agency_id = $1 order by m.client_id, m.id desc`,
    [agencyId],
  );
  threads.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  // Rascunhos esperando a equipe revisar antes de irem para o portal.
  const draftItems = await sql.query<{ id: string; client_id: string; client_name: string; kind: string; title: string; why: string | null; xodo_name: string | null; created_at: string }>(
    `select u.id, u.client_id, c.name as client_name, u.kind, u.title, u.why, x.name as xodo_name, u.created_at::text
       from client_updates u join clients c on c.id = u.client_id left join xodos x on x.id = u.xodo_id
      where u.agency_id = $1 and u.status = 'rascunho' order by u.created_at desc limit 50`,
    [agencyId],
  );
  // Aprovações da agência inteira: as que esperam o cliente e as decididas nos últimos 30 dias.
  const approvalItems = await sql.query<{ id: string; client_id: string; client_name: string; title: string; status: string; comment: string | null; document_id: string | null; link: string | null; decided_by_name: string | null; decided_at: string | null; created_at: string }>(
    `select a.id, a.client_id, c.name as client_name, a.title, a.status, a.comment, a.document_id, a.link,
            coalesce(p.full_name, u.email) as decided_by_name, a.decided_at::text, a.created_at::text
       from client_approvals a join clients c on c.id = a.client_id
       left join profiles p on p.id = a.decided_by left join auth.users u on u.id = a.decided_by
      where a.agency_id = $1 and (a.status = 'pendente' or (a.status <> 'cancelado' and a.decided_at > now() - interval '30 days'))
      order by (a.status = 'pendente') desc, coalesce(a.decided_at, a.created_at) desc limit 50`,
    [agencyId],
  );
  return { ...row!, unread: await unreadBy(sql, agencyId, "agencia"), threads, draft_items: draftItems, approval_items: approvalItems };
}

export const portalSettingsInput = z.object({ auto_publicar: z.boolean() }).partial();

export async function setPortalSettings(sql: Sql, agencyId: string, raw: unknown) {
  const input = portalSettingsInput.parse(raw);
  const row = await one<{ portal_settings: Record<string, unknown> }>(
    sql,
    `update agencies set portal_settings = portal_settings || $2::jsonb where id = $1 returning portal_settings`,
    [agencyId, json(input)],
  );
  return row!.portal_settings;
}
