import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";

/**
 * App de celular (PWA): os avisos do Spherum (tabela notifications) viram notificação no aparelho.
 * Cada aviso cai numa categoria; quem desligou a categoria ou está no horário de silêncio não recebe.
 * Aviso para uma pessoa (user_id) vai só para ela; aviso da agência vai para toda a equipe.
 */

export const CATEGORIES = ["appr", "hot", "fail", "chat", "xodo"] as const;
type Cat = (typeof CATEGORIES)[number];
const TZ = "America/Sao_Paulo";

/** Categoria de cada tipo de aviso (o que não está aqui não vira push). */
export function categoryOf(kind: string): Cat | null {
  if (/^(approval_pending|takeover_requested|aprovado_pelo_cliente|ajuste_pedido_pelo_cliente)$/.test(kind)) return "appr";
  if (/^(lead_formulario|reuniao_agendada|reuniao_cancelada)$/.test(kind)) return "hot";
  if (/^(post_falhou|nota_com_erro|fatura_atrasada|routine_failed|budget_capped|integracao_expirando|connection_expiring)$/.test(kind)) return "fail";
  if (/^(chat_mencao|reconhecimento|trilha_atribuida|onboarding_pendente)$/.test(kind)) return "chat";
  if (/^(xodo_message|budget_warning|automacao|tool)$/.test(kind)) return "xodo";
  return null;
}

export type PushMessage = { title: string; body: string; url: string; tag: string };
export type PushSender = (device: { endpoint: string; p256dh: string; auth: string }, msg: PushMessage) => Promise<"ok" | "gone">;

export const deviceInput = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
  label: z.string().trim().max(120).optional(),
});

export async function addDevice(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const i = deviceInput.parse(raw);
  const row = await one<{ id: string }>(
    sql,
    `insert into push_devices (agency_id, user_id, endpoint, p256dh, auth, label) values ($1, $2, $3, $4, $5, $6)
     on conflict (endpoint) do update set agency_id = excluded.agency_id, p256dh = excluded.p256dh, auth = excluded.auth,
       label = coalesce(excluded.label, push_devices.label), last_seen_at = now(), last_error = null
     where push_devices.user_id = excluded.user_id
     returning id`,
    [agencyId, userId, i.endpoint, i.keys.p256dh, i.keys.auth, i.label ?? null],
  );
  // A mesma inscrição do navegador pertence a outra pessoa: ninguém toma o aparelho de outro usuário.
  if (!row) throw new XodoError("Esse aparelho já está ligado a outra conta. Saia dela e ative de novo.", 409);
  return row;
}

export async function removeDevice(sql: Sql, userId: string, id: string) {
  const r = await one(sql, `delete from push_devices where id = $1 and user_id = $2 returning id`, [id, userId]);
  if (!r) throw new XodoError("Aparelho não encontrado.", 404);
}

export const prefsInput = z.object({ categories: z.array(z.enum(CATEGORIES)).max(5).optional(), quiet_start: z.number().int().min(0).max(23).nullable().optional(), quiet_end: z.number().int().min(0).max(23).nullable().optional() });

export async function getPrefs(sql: Sql, agencyId: string, userId: string) {
  const p = await one<{ categories: Cat[]; quiet_start: number | null; quiet_end: number | null }>(sql, `select categories, quiet_start, quiet_end from push_prefs where agency_id = $1 and user_id = $2`, [agencyId, userId]);
  return p ?? { categories: ["appr", "hot", "fail", "chat"] as Cat[], quiet_start: 22, quiet_end: 7 };
}

export async function setPrefs(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const i = prefsInput.parse(raw);
  const cur = await getPrefs(sql, agencyId, userId);
  const next = { categories: i.categories ?? cur.categories, quiet_start: i.quiet_start === undefined ? cur.quiet_start : i.quiet_start, quiet_end: i.quiet_end === undefined ? cur.quiet_end : i.quiet_end };
  await sql.query(
    `insert into push_prefs (agency_id, user_id, categories, quiet_start, quiet_end) values ($1, $2, $3, $4, $5)
     on conflict (agency_id, user_id) do update set categories = excluded.categories, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_at = now()`,
    [agencyId, userId, next.categories, next.quiet_start, next.quiet_end],
  );
  return next;
}

/** Dentro do horário de silêncio (que pode virar a meia-noite, ex.: 22h às 7h)? */
export function quiet(start: number | null, end: number | null, now: Date) {
  if (start === null || end === null || start === end) return false;
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now)) % 24;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

const urlFor = (kind: string, data: Record<string, unknown>) => {
  const v = categoryOf(kind) === "appr" ? "xodo" : /fatura|nota/.test(kind) ? "fiscal" : /post/.test(kind) ? "publish" : /lead|reuniao/.test(kind) ? (kind.startsWith("reuniao") ? "sched" : "crm") : /trilha|onboarding/.test(kind) ? "academy" : "dashboard";
  return `/prototipo/agencia.html#${v}${data.client_id ? `:${data.client_id}` : ""}`;
};

/** Cron: entrega os avisos novos (dos últimos 2 dias) por push. No silêncio ou com a categoria desligada, a pessoa não recebe (o aviso continua no app). */
export async function pushSweep(sql: Sql, send: PushSender, now = new Date(), opts: { deadline?: number } = {}) {
  const rows = await sql.query<{ id: number; agency_id: string; user_id: string | null; kind: string; title: string; body: string; data: Record<string, unknown> }>(
    `select id, agency_id, user_id, kind, title, body, data from notifications where pushed_at is null and created_at > $1::timestamptz - interval '2 days' order by id limit 300`,
    [now.toISOString()]);
  const out = { sent: 0, skipped: 0, quiet: 0, gone: 0 };
  for (const n of rows) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    // Marca antes de mandar: duas varreduras juntas não entregam o mesmo aviso duas vezes.
    if (!(await one(sql, `update notifications set pushed_at = $2 where id = $1 and pushed_at is null returning id`, [n.id, now.toISOString()]))) continue;
    const cat = categoryOf(n.kind);
    const targets = cat ? await sql.query<{ user_id: string; categories: Cat[] | null; quiet_start: number | null; quiet_end: number | null }>(
      `select m.user_id, p.categories, p.quiet_start, p.quiet_end from agency_members m left join push_prefs p on p.agency_id = m.agency_id and p.user_id = m.user_id
        where m.agency_id = $1 and ($2::uuid is null or m.user_id = $2) and exists (select 1 from push_devices d where d.agency_id = m.agency_id and d.user_id = m.user_id)`,
      [n.agency_id, n.user_id]) : [];
    for (const t of targets) {
      const cats = t.categories ?? ["appr", "hot", "fail", "chat"];
      if (!cats.includes(cat!)) continue;
      // Sem preferência gravada: silêncio padrão das 22h às 7h.
      if (quiet(t.categories ? t.quiet_start : 22, t.categories ? t.quiet_end : 7, now)) { out.quiet++; continue; }
      const devices = await sql.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(`select id, endpoint, p256dh, auth from push_devices where agency_id = $1 and user_id = $2`, [n.agency_id, t.user_id]);
      for (const d of devices) {
        try {
          const r = await send(d, { title: n.title.slice(0, 120), body: (n.body || "").slice(0, 240), url: urlFor(n.kind, n.data ?? {}), tag: `${n.kind}:${n.id}` });
          if (r === "gone") { await sql.query(`delete from push_devices where id = $1`, [d.id]); out.gone++; } else out.sent++;
        } catch (error) {
          await sql.query(`update push_devices set last_error = $2 where id = $1`, [d.id, (error instanceof Error ? error.message : String(error)).slice(0, 300)]);
        }
      }
    }
    if (!targets.length || !cat) out.skipped++;
  }
  return out;
}

export async function appBoard(sql: Sql, agencyId: string, userId: string) {
  const [prefs, devices, team] = await Promise.all([
    getPrefs(sql, agencyId, userId),
    sql.query<{ id: string; label: string | null; created_at: string; last_seen_at: string; last_error: string | null }>(`select id, label, created_at::text, last_seen_at::text, last_error from push_devices where agency_id = $1 and user_id = $2 order by created_at`, [agencyId, userId]),
    one<{ n: number; with_app: number }>(sql, `select count(*)::int as n, count(*) filter (where exists (select 1 from push_devices d where d.agency_id = m.agency_id and d.user_id = m.user_id))::int as with_app from agency_members m where m.agency_id = $1`, [agencyId]),
  ]);
  return { prefs, devices, team: team!, vapid_public_key: process.env.VAPID_PUBLIC_KEY ?? null };
}
