import { dayIn } from "../xodos/budget";
import type { Sql } from "../xodos/db";
import { SERVICE_STEPS } from "./admin";

/**
 * Página pública de status (/status e GET /api/status, sem login). Mostra só o que é da
 * plataforma: a situação de cada serviço, os incidentes abertos e os dos últimos 30 dias, com as
 * atualizações escritas pela equipe. Nada de agência, de pessoa ou de quem escreveu.
 *
 * A saúde de cada serviço vem das execuções do agendador (cron_runs): um dia é "instável" quando
 * mais de 10% das execuções falharam nas etapas daquele serviço. Um incidente aberto pesa mais.
 */

export const STATUS_SERVICES = [
  { id: "app", name: "Aplicativo e portais", desc: "Portal da agência, do cliente e admin" },
  { id: "meta", name: "Integração Meta Ads", desc: "Leitura de campanhas e publicação" },
  { id: "google", name: "Integração Google Ads", desc: "Leitura de campanhas" },
  { id: "wa", name: "WhatsApp", desc: "Prospecção e mensagens" },
  { id: "xodo", name: "Xodós", desc: "Computadores na nuvem e chamadas de IA" },
  { id: "pay", name: "Pagamentos", desc: "Cobrança de assinaturas e add-ons" },
] as const;

export type DayState = "ok" | "minor" | "major" | "critical" | "none";
const TZ = "America/Sao_Paulo";
const DAYS = 30;
const RANK: Record<DayState, number> = { none: 0, ok: 1, minor: 2, major: 3, critical: 4 };
const worse = (a: DayState, b: DayState): DayState => (RANK[b] > RANK[a] ? b : a);

export async function publicStatus(sql: Sql, now = new Date()) {
  const since = new Date(now.getTime() - DAYS * 864e5).toISOString();
  const [incidents, updates, runs] = await Promise.all([
    sql.query<{ id: string; service: string; title: string; severity: string; status: string; started_at: string; resolved_at: string | null }>(
      `select id, service, title, severity, status, started_at::text, resolved_at::text from status_incidents
        where status <> 'resolved' or resolved_at >= $1::timestamptz order by started_at desc limit 100`, [since]),
    sql.query<{ incident_id: string; status: string; text: string; created_at: string }>(
      `select u.incident_id, u.status, u.text, u.created_at::text from status_updates u join status_incidents i on i.id = u.incident_id
        where i.status <> 'resolved' or i.resolved_at >= $1::timestamptz order by u.created_at desc`, [since]),
    sql.query<{ started_at: string; failed: string[] }>(`select started_at::text, failed from cron_runs where started_at >= $1::timestamptz`, [since]),
  ]);

  const days = Array.from({ length: DAYS }, (_, k) => dayIn(TZ, new Date(now.getTime() - (DAYS - 1 - k) * 864e5)));
  const today = days[days.length - 1];
  const runsByDay = new Map<string, { failed: string[] }[]>();
  for (const r of runs) {
    const d = dayIn(TZ, new Date(r.started_at));
    runsByDay.set(d, [...(runsByDay.get(d) ?? []), r]);
  }
  const sev = (s: string): DayState => (s === "critical" ? "critical" : s === "major" ? "major" : "minor");

  const services = STATUS_SERVICES.map((s) => {
    const steps = SERVICE_STEPS[s.id] ?? [];
    const mine = incidents.filter((i) => i.service === s.id);
    const open = mine.filter((i) => i.status !== "resolved");
    let total = 0, bad = 0;
    const bars = days.map((day) => {
      const dayRuns = runsByDay.get(day) ?? [];
      const failed = dayRuns.filter((r) => r.failed.some((f) => steps.includes(f))).length;
      total += dayRuns.length;
      bad += failed;
      let state: DayState = dayRuns.length ? (failed / dayRuns.length > 0.1 ? "minor" : "ok") : "none";
      for (const i of mine) {
        const from = dayIn(TZ, new Date(i.started_at)), to = i.resolved_at ? dayIn(TZ, new Date(i.resolved_at)) : today;
        if (from <= day && day <= to) state = worse(state, sev(i.severity));
      }
      return { day, state };
    });
    const current = open.reduce<DayState>((w, i) => worse(w, sev(i.severity)), "ok");
    return { id: s.id, name: s.name, desc: s.desc, state: current, uptime: total ? Math.round(((total - bad) / total) * 10000) / 100 : null, bars };
  });

  const byIncident = new Map<string, { status: string; text: string; created_at: string }[]>();
  for (const u of updates) byIncident.set(u.incident_id, [...(byIncident.get(u.incident_id) ?? []), { status: u.status, text: u.text, created_at: u.created_at }]);
  const shape = (i: (typeof incidents)[number]) => ({
    id: i.id, service: i.service, title: i.title, severity: i.severity, status: i.status, started_at: i.started_at, resolved_at: i.resolved_at,
    updates: byIncident.get(i.id) ?? [],
  });
  const open = incidents.filter((i) => i.status !== "resolved").map(shape);
  const overall = services.reduce<DayState>((w, s) => worse(w, s.state), "ok");
  return {
    updated_at: now.toISOString(),
    overall,
    services,
    open,
    history: incidents.filter((i) => i.status === "resolved").map(shape),
  };
}
