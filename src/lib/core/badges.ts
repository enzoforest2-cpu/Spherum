import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/**
 * Conquistas da equipe: pontos por entregas que o Spherum mede (tarefa no prazo, relatório publicado,
 * chamado resolvido no prazo, criativo aprovado de primeira, aula concluída, reconhecimento de um
 * colega), ranking da semana ou do mês, emblemas do mês e um desafio da equipe.
 */

export const RULES = [
  ["task", "Tarefa entregue no prazo", "task_alt", 10],
  ["rep", "Relatório publicado", "lab_profile", 15],
  ["tk", "Chamado resolvido no prazo", "support_agent", 8],
  ["cr", "Criativo aprovado de primeira", "palette", 12],
  ["tr", "Aula de trilha concluída", "school", 5],
  ["kudo", "Reconhecimento de um colega", "favorite", 20],
] as const;
type RuleKey = (typeof RULES)[number][0];
const TZ_OFFSET = "-03:00";

export const configInput = z.object({
  points: z.partialRecord(z.enum(RULES.map((r) => r[0]) as [RuleKey, ...RuleKey[]]), z.number().int().min(0).max(100)).optional(),
  show_ranking: z.boolean().optional(),
  challenge: z.object({ title: z.string().trim().min(5).max(160), prize: z.string().trim().min(2).max(120) }).nullable().optional(),
});
type Config = { points: Record<RuleKey, number>; show_ranking: boolean; challenge: { title: string; prize: string } | null };

export async function getConfig(sql: Sql, agencyId: string): Promise<Config> {
  const c = (await one<{ c: Partial<Config> }>(sql, `select badge_config as c from agencies where id = $1`, [agencyId]))?.c ?? {};
  return {
    points: { ...Object.fromEntries(RULES.map((r) => [r[0], r[3]])), ...(c.points ?? {}) } as Record<RuleKey, number>,
    show_ranking: c.show_ranking ?? true,
    challenge: c.challenge === undefined ? { title: "Nenhum chamado fora do prazo neste mês", prize: "almoço da equipe por conta da agência" } : c.challenge,
  };
}

export async function setConfig(sql: Sql, agencyId: string, raw: unknown) {
  const i = configInput.parse(raw);
  const cur = await getConfig(sql, agencyId);
  const next = { points: { ...cur.points, ...(i.points ?? {}) }, show_ranking: i.show_ranking ?? cur.show_ranking, challenge: i.challenge === undefined ? cur.challenge : i.challenge };
  await sql.query(`update agencies set badge_config = $2::jsonb where id = $1`, [agencyId, json(next)]);
  return next;
}

export async function giveKudos(sql: Sql, agencyId: string, fromUser: string, raw: unknown) {
  const i = z.object({ to_user: z.uuid(), text: z.string().trim().min(3).max(500) }).parse(raw);
  if (i.to_user === fromUser) throw new XodoError("Reconheça um colega (não vale para você mesmo).", 400);
  if (!(await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, i.to_user]))) throw new XodoError("Essa pessoa não é da equipe.", 400);
  const today = await one<{ n: number }>(sql, `select count(*)::int as n from kudos where agency_id = $1 and from_user = $2 and to_user = $3 and created_at > now() - interval '1 day'`, [agencyId, fromUser, i.to_user]);
  if (today!.n) throw new XodoError("Você já reconheceu essa pessoa hoje.", 429);
  await sql.query(`insert into kudos (agency_id, from_user, to_user, text) values ($1, $2, $3, $4)`, [agencyId, fromUser, i.to_user, i.text]);
  await sql.query(`insert into notifications (agency_id, user_id, kind, title) values ($1, $2, 'reconhecimento', $3)`, [agencyId, i.to_user, `Você recebeu um reconhecimento: “${i.text}”`.slice(0, 200)]);
}

/** Contagem por pessoa e regra num período. */
async function counts(sql: Sql, agencyId: string, from: string, to: string) {
  const q = (s: string) => sql.query<{ user_id: string; n: number }>(s, [agencyId, from, to]);
  const [task, rep, tk, cr, tr, kudo] = await Promise.all([
    q(`select coalesce(assignee_user, done_by) as user_id, count(*)::int as n from project_tasks
        where agency_id = $1 and done and done_at >= $2 and done_at < $3 and (due_date is null or (done_at at time zone 'America/Sao_Paulo')::date <= due_date) group by 1`),
    q(`select created_by_user as user_id, count(*)::int as n from reports where agency_id = $1 and status = 'published' and published_at >= $2 and published_at < $3 and created_by_user is not null group by 1`),
    q(`select assignee_user as user_id, count(*)::int as n from tickets where agency_id = $1 and resolved_at >= $2 and resolved_at < $3 and resolved_at <= due_at and assignee_user is not null group by 1`),
    q(`select created_by as user_id, count(*)::int as n from content_posts where agency_id = $1 and approved_at >= $2 and approved_at < $3 and version = 1 and created_by is not null group by 1`),
    q(`select p.user_id, count(*)::int as n from academy_progress p join academy_items i on i.id = p.item_id where p.agency_id = $1 and i.kind = 'trilha' and p.done_at >= $2 and p.done_at < $3 and p.user_id is not null group by 1`),
    q(`select to_user as user_id, count(*)::int as n from kudos where agency_id = $1 and created_at >= $2 and created_at < $3 group by 1`),
  ]);
  const out: Record<string, Record<RuleKey, number>> = {};
  for (const [k, rows] of Object.entries({ task, rep, tk, cr, tr, kudo }) as [RuleKey, { user_id: string; n: number }[]][]) {
    for (const r of rows) {
      if (!r.user_id) continue;
      out[r.user_id] ??= { task: 0, rep: 0, tk: 0, cr: 0, tr: 0, kudo: 0 };
      out[r.user_id][k] = r.n;
    }
  }
  return out;
}

const dayIso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const startOf = (day: string) => new Date(`${day}T00:00:00${TZ_OFFSET}`);

export async function badgeBoard(sql: Sql, agencyId: string, userId: string, period: "week" | "month" = "month", now = new Date()) {
  const cfg = await getConfig(sql, agencyId);
  const today = dayIso(now), monthStart = startOf(`${today.slice(0, 7)}-01`);
  const dow = (new Date(`${today}T12:00:00${TZ_OFFSET}`).getUTCDay() + 6) % 7;
  const weekStart = new Date(startOf(today).getTime() - dow * 864e5);
  const end = new Date(startOf(today).getTime() + 864e5).toISOString();
  const [members, cPeriod, cMonth, trailsDone, saved, feed, role, lateTickets] = await Promise.all([
    sql.query<{ user_id: string; name: string; title: string | null; role: string; since: string }>(
      `select m.user_id, coalesce(p.full_name, u.email) as name, m.title, m.role, m.created_at::text as since from agency_members m
         left join profiles p on p.id = m.user_id left join auth.users u on u.id = m.user_id where m.agency_id = $1`, [agencyId]),
    counts(sql, agencyId, (period === "week" ? weekStart : monthStart).toISOString(), end),
    counts(sql, agencyId, monthStart.toISOString(), end),
    sql.query<{ user_id: string; name: string }>(
      `select p.user_id, i.name from academy_items i join academy_progress p on p.item_id = i.id
        where i.agency_id = $1 and i.kind = 'trilha' and jsonb_array_length(i.steps) > 0 and p.user_id is not null
        group by p.user_id, i.id, i.name having count(*) >= jsonb_array_length(i.steps)`, [agencyId]),
    sql.query<{ user_id: string }>(`select distinct created_by as user_id from risk_actions where agency_id = $1 and created_at >= $2 and created_by is not null`, [agencyId, monthStart.toISOString()]),
    sql.query<{ kind: string; who: string; from_name: string | null; text: string; at: string }>(
      `select 'kudo' as kind, coalesce(pt.full_name, ut.email) as who, coalesce(pf.full_name, uf.email) as from_name, k.text, k.created_at::text as at
         from kudos k left join profiles pt on pt.id = k.to_user left join auth.users ut on ut.id = k.to_user
         left join profiles pf on pf.id = k.from_user left join auth.users uf on uf.id = k.from_user
        where k.agency_id = $1 order by k.created_at desc limit 8`, [agencyId]),
    one<{ role: string }>(sql, `select role from agency_members where agency_id = $1 and user_id = $2`, [agencyId, userId]),
    sql.query<{ day: string }>(
      `select distinct (coalesce(resolved_at, $3::timestamptz) at time zone 'America/Sao_Paulo')::date::text as day from tickets
        where agency_id = $1 and due_at >= $2 and due_at < $3 and coalesce(resolved_at, $3::timestamptz) > due_at`,
      [agencyId, monthStart.toISOString(), now.toISOString()]),
  ]);
  const pts = (c?: Record<RuleKey, number>) => c ? RULES.reduce((t, r) => t + c[r[0]] * cfg.points[r[0]], 0) : 0;
  const boss = role && ["owner", "admin"].includes(role.role);
  const ranking = members.map((m) => ({ user_id: m.user_id, name: m.name, title: m.title, points: pts(cPeriod[m.user_id]), counts: cPeriod[m.user_id] ?? { task: 0, rep: 0, tk: 0, cr: 0, tr: 0, kudo: 0 } }))
    .sort((a, b) => b.points - a.points)
    .filter((r) => cfg.show_ranking || boss || r.user_id === userId);
  const mo = (u: string) => cMonth[u] ?? { task: 0, rep: 0, tk: 0, cr: 0, tr: 0, kudo: 0 };
  const names = (f: (m: (typeof members)[number]) => boolean) => members.filter(f).map((m) => m.name);
  const yearAgo = now.getTime() - 365 * 864e5;
  const badges = [
    ["schedule", "Prazo de ouro", "20 tarefas no prazo no mês", names((m) => mo(m.user_id).task >= 20)],
    ["palette", "Primeira de primeira", "10 criativos aprovados sem ajuste no mês", names((m) => mo(m.user_id).cr >= 10)],
    ["support_agent", "Resposta rápida", "20 chamados resolvidos no prazo no mês", names((m) => mo(m.user_id).tk >= 20)],
    ["lab_profile", "Relatório redondo", "8 relatórios publicados no mês", names((m) => mo(m.user_id).rep >= 8)],
    ["school", "Sempre aprendendo", "Uma trilha inteira concluída", names((m) => trailsDone.some((t) => t.user_id === m.user_id))],
    ["favorite", "Querido do time", "5 reconhecimentos de colegas no mês", names((m) => mo(m.user_id).kudo >= 5)],
    ["trending_up", "Cliente salvo", "Tratou um cliente em risco no radar neste mês", names((m) => saved.some((s) => s.user_id === m.user_id))],
    ["workspace_premium", "Um ano de casa", "12 meses na agência", names((m) => Date.parse(m.since) < yearAgo)],
  ].map(([icon, name, desc, who]) => ({ icon, name, desc, who }));
  const day = Number(today.slice(8)), daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  return {
    config: cfg, period, ranking, badges,
    rules: RULES.map(([key, label, icon]) => ({ key, label, icon, points: cfg.points[key] })),
    challenge: cfg.challenge ? { ...cfg.challenge, days_ok: day - lateTickets.length, days_so_far: day, days_in_month: daysInMonth } : null,
    feed: [...feed.map((f) => ({ who: f.who, text: `recebeu um reconhecimento${f.from_name ? ` de ${f.from_name.split(" ")[0]}` : ""}: “${f.text}”`, at: f.at })),
      ...trailsDone.map((t) => ({ who: members.find((m) => m.user_id === t.user_id)?.name ?? "", text: `concluiu a trilha ${t.name}.`, at: null as string | null }))].slice(0, 8),
  };
}
