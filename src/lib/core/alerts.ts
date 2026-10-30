import type { Sql } from "../xodos/db";
import type { Mailer } from "./email";

/**
 * Alertas para a equipe do Spherum, por e-mail (ALERT_EMAIL, ou o e-mail do suporte). Cada assunto
 * (key) avisa no máximo uma vez a cada `cooldownHours`, e todo alerta fica em staff_alerts para o
 * admin ver, mesmo sem e-mail configurado.
 */
export async function staffAlert(
  sql: Sql,
  mail: Mailer,
  a: { key: string; subject: string; text: string; cooldownHours?: number },
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const recent = await sql.query(
    `select 1 from staff_alerts where key = $1 and created_at > now() - make_interval(hours => $2)`,
    [a.key, a.cooldownHours ?? 6],
  );
  if (recent.length) return false;
  await sql.query(`insert into staff_alerts (key, subject, text) values ($1, $2, $3)`, [a.key, a.subject.slice(0, 200), a.text.slice(0, 4000)]);
  const to = env.ALERT_EMAIL || env.SUPPORT_NOTIFY_EMAIL || env.LEADS_NOTIFY_EMAIL;
  if (to) await mail({ to, subject: `[Spherum] ${a.subject}`, text: a.text }).catch(() => false);
  return true;
}

/**
 * Depois de cada ciclo do agendador: etapa que falhou em dois ciclos seguidos vira alerta (uma falha
 * solta, como um provedor fora do ar por um minuto, não acorda ninguém).
 */
export async function cronAlerts(sql: Sql, mail: Mailer, env: Record<string, string | undefined> = process.env) {
  const runs = await sql.query<{ failed: string[]; result: Record<string, unknown> }>(
    `select failed, result from cron_runs order by started_at desc limit 2`,
  );
  if (runs.length < 2) return [];
  const [last, before] = runs;
  const steps = last.failed.filter((s) => before.failed.includes(s));
  const sent: string[] = [];
  for (const s of steps) {
    const why = String(last.result[s] ?? "").replace(/^falhou:\s*/, "").slice(0, 500);
    const ok = await staffAlert(sql, mail, {
      key: `cron:${s}`,
      subject: `A etapa "${s}" do agendador falhou duas vezes seguidas`,
      text: `A etapa "${s}" falhou nos dois últimos ciclos do agendador (a cada 15 minutos).\n\nÚltimo erro: ${why || "sem detalhe"}\n\nVeja Status no admin do Spherum. Este aviso não se repete por 6 horas.`,
    }, env);
    if (ok) sent.push(s);
  }
  return sent;
}

/** Quanto tempo desde o último ciclo do agendador (para um monitor externo checar em /api/saude). */
export async function lastCronMinutes(sql: Sql): Promise<number | null> {
  const r = await sql.query<{ m: number }>(`select extract(epoch from now() - max(started_at))::int / 60 as m from cron_runs`);
  return r[0]?.m ?? null;
}
