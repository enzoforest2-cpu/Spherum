import { z } from "zod";
import type { Sql } from "../xodos/db";
import { platformFlags } from "./platform";

/**
 * Notificações no app da agência: as da agência inteira (user_id nulo) e as da pessoa. Ler uma
 * notificação da agência inteira marca para todos, como uma caixa de entrada compartilhada.
 * O aviso do topo junta, por ordem de importância, a manutenção ligada no admin, o incidente aberto
 * e o último comunicado ainda não lido dos últimos 14 dias.
 */

export async function listNotifications(sql: Sql, agencyId: string, userId: string, limit = 40) {
  return sql.query<{ id: number; kind: string; title: string; body: string; data: Record<string, unknown>; created_at: string; read: boolean }>(
    `select id, kind, title, body, data, created_at::text, read_at is not null as read from notifications
      where agency_id = $1 and (user_id is null or user_id = $2) order by id desc limit $3`, [agencyId, userId, limit]);
}

export async function markNotificationsRead(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }).parse(raw ?? {});
  const r = await sql.query<{ id: number }>(
    `update notifications set read_at = now() where agency_id = $1 and (user_id is null or user_id = $2) and read_at is null
        and ($3::bigint[] is null or id = any($3::bigint[])) returning id`, [agencyId, userId, ids ?? null]);
  return { read: r.length };
}

const SERVICE: Record<string, string> = { app: "o app", meta: "a integração com o Meta", google: "a integração com o Google", wa: "o WhatsApp", xodo: "os xodós", pay: "os pagamentos" };

export async function platformNotice(sql: Sql, agencyId: string, now = new Date()) {
  const [flags, incident, comm] = await Promise.all([
    platformFlags(sql),
    sql.query<{ service: string; title: string; severity: string; text: string | null }>(
      `select i.service, i.title, i.severity, (select u.text from status_updates u where u.incident_id = i.id order by u.created_at desc limit 1) as text
         from status_incidents i where i.status <> 'resolved' order by (i.severity = 'critical') desc, (i.severity = 'major') desc, i.started_at desc limit 1`),
    sql.query<{ id: number; title: string; body: string; data: { cta_label?: string | null; cta_url?: string | null } }>(
      `select id, title, body, data from notifications where agency_id = $1 and kind = 'comunicado' and read_at is null and created_at > $2::timestamptz - interval '14 days'
        order by id desc limit 1`, [agencyId, now.toISOString()]),
  ]);
  if (flags.maint) return { tone: "amber", title: "Manutenção no Spherum", text: "Algumas partes podem ficar lentas ou fora do ar por alguns minutos. Nada do que vocês salvaram se perde.", id: null, cta_label: null, cta_url: null };
  const inc = incident[0];
  if (inc) return { tone: inc.severity === "minor" ? "amber" : "red", title: inc.title, text: inc.text || `Estamos cuidando de um problema com ${SERVICE[inc.service] ?? "o Spherum"}.`, id: null, cta_label: null, cta_url: null };
  const c = comm[0];
  if (c) return { tone: "blue", title: c.title, text: c.body, id: c.id, cta_label: c.data?.cta_label ?? null, cta_url: c.data?.cta_url ?? null };
  return null;
}
