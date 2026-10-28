import { COMPUTER_TOOLS } from "../computer/tools";
import { NATIVE_APP_TOOLS } from "../integrations/registry";
import { num, one, type Sql } from "./db";
import { MEMORY_TOOLS } from "./memory/tools";
import { TOOLS, type ToolDef } from "./tools";

/**
 * Dados da tela de Xodós do portal da agência (design/project/spherum/agencia_tpl.html, aba
 * Xodós): a equipe de xodós com o que cada um está fazendo, o gasto do dia, os pedidos de
 * aprovação, as regras, as chaves e o consumo do mês. A conversa de cada um vem de
 * /api/xodos/:id/messages quando a pessoa abre o xodó.
 */

const ALL: readonly ToolDef[] = [...TOOLS, ...MEMORY_TOOLS, ...COMPUTER_TOOLS, ...NATIVE_APP_TOOLS];
const BY_NAME = new Map(ALL.map((t) => [t.name, t]));

/** Frase curta do pedido ("publicar um relatório no portal do cliente"), com o motivo do limite. */
export function describeAction(toolName: string, input: unknown, reason: string | null): string {
  const tool = BY_NAME.get(toolName);
  let text = toolName.replace(/_/g, " ");
  if (tool) {
    try {
      text = tool.summarize(input as never);
    } catch {
      // Entrada antiga ou de outra versão: fica o nome da ferramenta.
    }
  }
  const why = reason?.startsWith("limite: ") ? ` (${reason.slice(8)})` : "";
  return text.charAt(0).toUpperCase() + text.slice(1) + why;
}

const day = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });

export async function xodoScreen(sql: Sql, agencyId: string, now = new Date()) {
  const agency = await one<{ timezone: string; plan: string }>(sql, `select timezone, plan from agencies where id = $1`, [agencyId]);
  const tz = agency?.timezone || "America/Sao_Paulo";
  const today = day(now, tz);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [xodos, spend, month, runs, pending, memories, apps, routines, rules, credentials, triggers] = await Promise.all([
    sql.query<{ id: string; name: string; species: string; color: string; personality: string; role: string | null; instructions: string; autonomy: string; provider: string; model: string; credential_id: string | null; daily_budget_brl: number | null; warn_at_percent: number; status: string; created_at: string }>(
      `select id, name, species, color, personality, role, instructions, autonomy, provider, model, credential_id,
              daily_budget_brl::float8 as daily_budget_brl, warn_at_percent, status, created_at::text
         from xodos where agency_id = $1 order by created_at`,
      [agencyId],
    ),
    sql.query<{ xodo_id: string; spent: number }>(`select xodo_id, spent_brl::float8 as spent from xodo_budget_days where agency_id = $1 and day = $2::date`, [agencyId, today]),
    sql.query<{ xodo_id: string | null; brl: number; usd: number }>(
      `select xodo_id, coalesce(sum(cost_brl), 0)::float8 as brl, coalesce(sum(cost_usd), 0)::float8 as usd
         from ai_usage where agency_id = $1 and day >= $2::date group by xodo_id`,
      [agencyId, monthStart],
    ),
    sql.query<{ xodo_id: string; status: string; trigger: string; started_at: string; finished_at: string | null; error: string | null; last_text: string | null }>(
      `select distinct on (r.xodo_id) r.xodo_id, r.status, r.trigger, r.started_at::text, r.finished_at::text, r.error,
              (select m.text from xodo_messages m where m.run_id = r.id and m.role = 'assistant' order by m.id desc limit 1) as last_text
         from xodo_runs r where r.agency_id = $1 order by r.xodo_id, r.started_at desc`,
      [agencyId],
    ),
    sql.query<{ id: string; xodo_id: string; tool_name: string; category: string; input: unknown; reason: string | null; expires_at: string | null; created_at: string }>(
      `select id, xodo_id, tool_name, category, input, reason, expires_at::text, created_at::text from xodo_actions
        where agency_id = $1 and status = 'pending' order by created_at`,
      [agencyId],
    ),
    sql.query<{ xodo_id: string; content: string; n: number }>(
      `select xodo_id, content, n from (
         select xodo_id, content, n, row_number() over (partition by xodo_id order by pinned desc, kept_in_core desc, updated_at desc) as k
           from xodo_memory_items where agency_id = $1 and status = 'ativo') m where k <= 5`,
      [agencyId],
    ),
    sql.query<{ xodo_id: string; app: string }>(`select xodo_id, app from xodo_apps where agency_id = $1 order by app`, [agencyId]),
    sql.query<{ id: string; xodo_id: string; name: string; cron: string; active: boolean; next_run_at: string | null; last_summary: string | null }>(
      `select id, xodo_id, name, cron, active, next_run_at::text, last_summary from xodo_routines where agency_id = $1 order by created_at`,
      [agencyId],
    ),
    sql.query<{ id: string; xodo_id: string | null; effect: string; match_kind: string; match_value: string }>(
      `select id, xodo_id, effect, match_kind, match_value from approval_rules where agency_id = $1 order by created_at`,
      [agencyId],
    ),
    sql.query<{ id: string; provider: string; label: string; key_last4: string | null; kind: string }>(
      `select id, provider, label, key_last4, kind from ai_credentials where agency_id = $1 and revoked_at is null order by created_at`,
      [agencyId],
    ),
    sql.query<{ xodo_id: string; kind: string; name: string; enabled: boolean }>(
      `select xodo_id, kind, name, enabled from event_triggers where agency_id = $1 order by created_at`,
      [agencyId],
    ),
  ]);

  const spentBy = new Map(spend.map((s) => [s.xodo_id, num(s.spent)]));
  const monthBy = new Map(month.map((m) => [m.xodo_id, num(m.brl)]));
  const runBy = new Map(runs.map((r) => [r.xodo_id, r]));
  const group = <T extends { xodo_id: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.xodo_id) m.set(r.xodo_id, [...(m.get(r.xodo_id) ?? []), r]);
    return m;
  };
  const pendBy = group(pending);
  const memBy = group(memories);
  const appBy = group(apps);
  const routBy = group(routines);
  const trigBy = group(triggers);

  return {
    plan: agency?.plan ?? "agencia",
    today,
    xodos: xodos.map((x) => {
      const run = runBy.get(x.id);
      const pend = pendBy.get(x.id) ?? [];
      const spent = spentBy.get(x.id) ?? 0;
      const state =
        x.status === "paused"
          ? "paused_manual"
          : x.daily_budget_brl && spent >= x.daily_budget_brl
            ? "paused"
            : pend.length
              ? "needsYou"
              : run && (run.status === "running" || run.status === "waiting_takeover")
                ? "working"
                : run?.status === "completed" && run.finished_at && now.getTime() - Date.parse(run.finished_at) < 3_600_000
                  ? "done"
                  : "idle";
      return {
        ...x,
        state,
        spent_today: Math.round(spent * 100) / 100,
        spent_month: Math.round((monthBy.get(x.id) ?? 0) * 100) / 100,
        last_run: run ?? null,
        pending: pend.length,
        memory: (memBy.get(x.id) ?? []).map((m) => m.content),
        apps: (appBy.get(x.id) ?? []).map((a) => a.app),
        routines: (routBy.get(x.id) ?? []).map(({ xodo_id: _x, ...r }) => (void _x, r)),
        triggers: (trigBy.get(x.id) ?? []).map(({ xodo_id: _x, ...t }) => (void _x, t)),
      };
    }),
    approvals: pending.map((a) => ({
      id: a.id,
      xodo_id: a.xodo_id,
      tool_name: a.tool_name,
      category: a.category,
      summary: describeAction(a.tool_name, a.input, a.reason),
      input: a.input,
      expires_at: a.expires_at,
      created_at: a.created_at,
    })),
    rules,
    credentials,
    month_brl: Math.round(month.reduce((t, m) => t + num(m.brl), 0) * 100) / 100,
  };
}
