import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { addTask, createProject } from "./projects";

/**
 * Busca por IA: cada cliente tem perguntas que alguém faria a um assistente ("melhor clínica de
 * harmonização em Curitiba"). O servidor pergunta a cada modelo com chave na agência e mede se a
 * marca aparece, em que lugar da lista e quais concorrentes foram citados.
 */

export const ENGINES = { openai: "ChatGPT", google: "Gemini", anthropic: "Claude", xai: "Grok", mistral: "Le Chat", deepseek: "DeepSeek" } as const;
export type Engine = keyof typeof ENGINES;
export type Asker = (agencyId: string, engine: Engine, question: string) => Promise<{ answer: string; model: string }>;
export type AivisDeps = { sql: Sql; ask: Asker; engines: (agencyId: string) => Promise<Engine[]> };

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const has = (text: string, name: string) => { const n = norm(name); return n.length >= 3 && ` ${norm(text)} `.includes(` ${n} `); };

/** Onde a marca aparece na resposta: posição na lista (1, 2…), citada fora de lista, ou nada. */
export function analyze(answer: string, names: string[], competitors: string[]) {
  const lines = answer.split(/\n+/);
  const items = lines.filter((l) => /^\s*(\d+[.)]|[-*•])\s+/.test(l));
  let position: number | null = null;
  const idx = items.findIndex((l) => names.some((n) => has(l, n)));
  if (idx >= 0) position = idx + 1;
  const mentioned = position !== null || names.some((n) => has(answer, n));
  return { position, mentioned, competitors: competitors.filter((c) => has(answer, c)) };
}

async function clientOf(sql: Sql, agencyId: string, clientId: string) {
  const c = await one<{ name: string; city: string | null }>(sql, `select name, city from clients where id = $1 and agency_id = $2`, [clientId, agencyId]);
  if (!c) throw new XodoError("Cliente não encontrado.", 404);
  return c;
}

export async function addQuery(sql: Sql, agencyId: string, userId: string, clientId: string, question: string) {
  const q = z.string().trim().min(5).max(300).parse(question);
  await clientOf(sql, agencyId, clientId);
  const n = await one<{ n: number }>(sql, `select count(*)::int as n from aivis_queries where client_id = $1`, [clientId]);
  if (n!.n >= 20) throw new XodoError("Até 20 perguntas por cliente.", 400);
  if (await one(sql, `select 1 from aivis_queries where client_id = $1 and lower(question) = lower($2)`, [clientId, q])) throw new XodoError("Essa pergunta já está na lista.", 409);
  return (await one<{ id: string }>(sql, `insert into aivis_queries (agency_id, client_id, question, created_by) values ($1, $2, $3, $4) returning id`, [agencyId, clientId, q, userId]))!;
}

export async function deleteQuery(sql: Sql, agencyId: string, id: string) {
  const r = await one(sql, `delete from aivis_queries where id = $1 and agency_id = $2 returning id`, [id, agencyId]);
  if (!r) throw new XodoError("Pergunta não encontrada.", 404);
}

export async function setClientSettings(sql: Sql, agencyId: string, clientId: string, raw: unknown) {
  const i = z.object({
    aliases: z.array(z.string().trim().min(2).max(80)).max(10).optional(),
    competitors: z.array(z.string().trim().min(2).max(80)).max(10).optional(),
    published: z.boolean().optional(),
  }).parse(raw);
  await clientOf(sql, agencyId, clientId);
  await sql.query(
    `insert into aivis_clients (client_id, agency_id, aliases, competitors, published) values ($1, $2, coalesce($3, '{}'::text[]), coalesce($4, '{}'::text[]), coalesce($5, false))
     on conflict (client_id) do update set aliases = coalesce($3, aivis_clients.aliases), competitors = coalesce($4, aivis_clients.competitors),
       published = coalesce($5, aivis_clients.published), updated_at = now()`,
    [clientId, agencyId, i.aliases ?? null, i.competitors ?? null, i.published ?? null],
  );
}

/** Checa as perguntas do cliente em cada modelo disponível (ou só nas que nunca foram checadas). */
export async function runChecks(deps: AivisDeps, agencyId: string, clientId: string, opts: { onlyNew?: boolean; onlyStale?: boolean; deadline?: number } = {}) {
  const { sql } = deps;
  const c = await clientOf(sql, agencyId, clientId);
  const engines = await deps.engines(agencyId);
  if (!engines.length) throw new XodoError("Cadastre uma chave de IA (OpenAI, Google, Anthropic…) em Xodós para checar.", 400);
  const s = await one<{ aliases: string[]; competitors: string[] }>(sql, `select aliases, competitors from aivis_clients where client_id = $1`, [clientId]);
  const names = [c.name, ...(s?.aliases ?? [])], comps = s?.competitors ?? [];
  // onlyStale: só o que não foi checado nos últimos 6 dias (a varredura semanal não refaz o que já está em dia).
  const filter = opts.onlyNew ? "and not exists (select 1 from aivis_checks k where k.query_id = q.id)"
    : opts.onlyStale ? "and not exists (select 1 from aivis_checks k where k.query_id = q.id and k.checked_at > now() - interval '6 days')" : "";
  const qs = await sql.query<{ id: string; question: string }>(`select q.id, q.question from aivis_queries q where q.client_id = $1 ${filter} order by q.created_at`, [clientId]);
  let done = 0, failed = 0;
  for (const q of qs) {
    for (const e of engines) {
      // Cada chamada de IA pode levar um minuto: perto do prazo do cron, o resto fica para o próximo ciclo.
      if (opts.deadline && Date.now() > opts.deadline - 60_000) return { checked: done, failed, engines, partial: true };
      try {
        const r = await deps.ask(agencyId, e, q.question);
        const a = analyze(r.answer, names, comps);
        await sql.query(`insert into aivis_checks (query_id, agency_id, engine, model, position, mentioned, competitors, answer) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [q.id, agencyId, e, r.model, a.position, a.mentioned, a.competitors, r.answer.slice(0, 6000)]);
        done++;
      } catch (error) {
        await sql.query(`insert into aivis_checks (query_id, agency_id, engine, mentioned, error) values ($1, $2, $3, false, $4)`, [q.id, agencyId, e, (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
        failed++;
      }
    }
  }
  return { checked: done, failed, engines, partial: false };
}

/** Cron semanal: checa de novo os clientes com perguntas (segunda-feira, uma vez por semana). */
export async function weeklyChecks(deps: AivisDeps, now = new Date(), opts: { deadline?: number } = {}) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(now);
  if (weekday !== "Mon") return { clients: 0 };
  const due = await deps.sql.query<{ agency_id: string; client_id: string }>(
    `select distinct q.agency_id, q.client_id from aivis_queries q join agencies a on a.id = q.agency_id
      where a.suspended_at is null and a.locked_at is null and not exists (select 1 from aivis_checks k where k.query_id = q.id and k.checked_at > $1::timestamptz - interval '6 days') limit 20`, [now.toISOString()]);
  let n = 0;
  for (const d of due) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    await runChecks(deps, d.agency_id, d.client_id, { onlyStale: true, deadline: opts.deadline }).catch(() => null);
    n++;
  }
  return { clients: n };
}

/** A tela: perguntas × modelos (última checagem), participação nas menções e dicas. */
export async function aivisBoard(sql: Sql, agencyId: string, clientId: string, engines: Engine[]) {
  const c = await clientOf(sql, agencyId, clientId);
  const [settings, queries, checks] = await Promise.all([
    one<{ aliases: string[]; competitors: string[]; published: boolean }>(sql, `select aliases, competitors, published from aivis_clients where client_id = $1`, [clientId]),
    sql.query<{ id: string; question: string }>(`select id, question from aivis_queries where client_id = $1 order by created_at`, [clientId]),
    sql.query<{ query_id: string; engine: string; position: number | null; mentioned: boolean; competitors: string[]; error: string | null; checked_at: string; answer: string | null }>(
      `select distinct on (k.query_id, k.engine) k.query_id, k.engine, k.position, k.mentioned, k.competitors, k.error, k.checked_at::text, k.answer
         from aivis_checks k join aivis_queries q on q.id = k.query_id where q.client_id = $1 order by k.query_id, k.engine, k.checked_at desc`, [clientId]),
  ]);
  const used = [...new Set([...engines, ...checks.map((k) => k.engine as Engine)])].filter((e) => e in ENGINES);
  const ok = checks.filter((k) => !k.error);
  const share: Record<string, number> = { [c.name]: ok.filter((k) => k.mentioned).length };
  for (const comp of settings?.competitors ?? []) share[comp] = ok.filter((k) => k.competitors.includes(comp)).length;
  const total = Object.values(share).reduce((a, b) => a + b, 0);
  const tips: string[] = [];
  const missing = queries.filter((q) => ok.some((k) => k.query_id === q.id) && !ok.some((k) => k.query_id === q.id && k.mentioned));
  if (missing.length) tips.push(`Criar uma página no site respondendo “${missing[0].question}”, com o nome da marca e a cidade.`);
  if (ok.some((k) => k.competitors.length && !k.mentioned)) tips.push("Pedir avaliações no Google e citações em sites locais: os concorrentes que aparecem costumam ter mais avaliações.");
  if (ok.length && ok.filter((k) => k.mentioned).length / ok.length < 0.5) tips.push("Padronizar nome, endereço e telefone no Google, no Instagram e nos diretórios (os modelos cruzam essas fontes).");
  if (!queries.length) tips.push("Comece com 3 a 5 perguntas que um cliente faria antes de escolher, com a cidade.");
  return {
    client: c.name, engines: used.map((e) => ({ id: e, name: ENGINES[e as Engine] })), settings: settings ?? { aliases: [], competitors: [], published: false },
    queries: queries.map((q) => ({ ...q, cells: Object.fromEntries(used.map((e) => { const k = checks.find((x) => x.query_id === q.id && x.engine === e); return [e, k ? { position: k.position, mentioned: k.mentioned, error: k.error, checked_at: k.checked_at, answer: k.answer } : null]; })) })),
    stats: { checked: ok.length, mentioned: ok.filter((k) => k.mentioned).length, first: ok.filter((k) => k.position === 1).length, share_pct: total ? Math.round((share[c.name] / total) * 100) : null },
    share: Object.entries(share).map(([name, n]) => ({ name, pct: total ? Math.round((n / total) * 100) : 0, mine: name === c.name })).sort((a, b) => b.pct - a.pct),
    tips,
  };
}

/** Dica vira tarefa no projeto do cliente "Presença nas buscas por IA". */
export async function tipToTask(sql: Sql, agencyId: string, userId: string, clientId: string, raw: unknown, now = new Date()) {
  const i = z.object({ title: z.string().trim().min(4).max(200), assignee_user: z.uuid().nullable().optional(), due_date: z.iso.date() }).parse(raw);
  const c = await clientOf(sql, agencyId, clientId);
  const name = `Presença nas buscas por IA · ${c.name}`.slice(0, 160);
  let p = await one<{ id: string; due_date: string }>(sql, `select id, due_date::text from projects where agency_id = $1 and client_id = $2 and name = $3 and status <> 'done'`, [agencyId, clientId, name]);
  if (!p) p = { id: (await createProject(sql, agencyId, userId, { name, client_id: clientId, owner_user: userId, tags: ["Busca por IA"], due_date: i.due_date }, now)).id, due_date: i.due_date };
  if (i.due_date > p.due_date) await sql.query(`update projects set due_date = $2 where id = $1`, [p.id, i.due_date]);
  return addTask(sql, agencyId, p.id, { title: i.title, assignee_user: i.assignee_user ?? null, due_date: i.due_date });
}

/**
 * O que o cliente vê no portal, quando a agência publica: perguntas × modelos (posição ou citação), participação nas
 * menções e a data da última checagem. Sem as respostas completas e sem as dicas internas da agência.
 */
export async function clientAivis(sql: Sql, agencyId: string, clientId: string) {
  const pub = await one<{ published: boolean }>(sql, `select published from aivis_clients where client_id = $1 and agency_id = $2`, [clientId, agencyId]);
  if (!pub?.published) return null;
  const b = await aivisBoard(sql, agencyId, clientId, []);
  const last = b.queries.flatMap((q) => Object.values(q.cells)).filter((c) => c && !c.error).map((c) => c!.checked_at).sort().pop() ?? null;
  return {
    engines: b.engines,
    queries: b.queries.map((q) => ({
      id: q.id, question: q.question,
      cells: Object.fromEntries(Object.entries(q.cells).map(([e, c]) => [e, c && !c.error ? { position: c.position, mentioned: c.mentioned } : null])),
    })),
    stats: b.stats, share: b.share, last_checked: last,
  };
}
