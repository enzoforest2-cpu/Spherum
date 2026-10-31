import { z, ZodError } from "zod";
import { setFilesRoot } from "../src/local/files";
import { decideAction } from "../src/xodos/actions";
import { one, type Sql } from "../src/xodos/db";
import { XodoError } from "../src/xodos/errors";
import { serverLlm } from "../src/xodos/llm";
import { createCredential, createXodo, deleteXodo, listCredentials, revokeCredential, updateXodo } from "../src/xodos/manage";
import { conflictBody, createNote, deleteNote, editNote, listMemory } from "../src/xodos/memory/team";
import { createRoutine, nextRunAt } from "../src/xodos/routines";
import { loadXodo, startRun, type EngineDeps } from "../src/xodos/runner";
import { TOOLS_BY_NAME } from "../src/xodos/tools";
import { NATIVE_APP_TOOLS } from "../src/integrations/registry";
import type { IntegrationDeps } from "../src/integrations/store";
import type { Channels } from "./channels";
import { connections, disconnect, googleConfigured, saveGoogleClient, startGoogleLogin } from "./integrations";
import { ensureOwner, writeSettings, type AppState } from "./state";
import type { Worker } from "./worker";

/**
 * As rotas do app. Só você usa: não há login, mas o servidor só atende o próprio computador
 * (ver main.ts) e toda chamada leva o token da página.
 */

// Mensagens de validação em português ("Pequeno demais: …"), não em inglês.
z.config(z.locales.ptBR());

export type Ctx = { deps: EngineDeps; state: AppState; worker: Worker; channels: Channels };

function integrationsOf(c: Ctx): IntegrationDeps {
  if (!c.deps.integrations) throw new XodoError("Integrações desligadas.", 503);
  return { ...c.deps.integrations, sql: c.deps.sql, now: c.deps.now };
}
type Req = { method: string; path: string; query: URLSearchParams; body: unknown };
export type Res = { status: number; body: unknown };

const uuid = z.uuid();
const ok = (body: unknown, status = 200): Res => ({ status, body });

/** Erros conhecidos viram mensagem para a tela; o resto vira "erro interno" (e vai para o log). */
export function failure(error: unknown): Res {
  if (error instanceof XodoError) return { status: error.status, body: { error: error.message } };
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return { status: 400, body: { error: `Dados inválidos${first?.path.length ? ` em ${first.path.join(".")}` : ""}: ${first?.message ?? ""}` } };
  }
  const conflict = conflictBody(error);
  if (conflict) return { status: 409, body: conflict };
  console.error("[api] erro", error);
  return { status: 500, body: { error: "Erro interno. Veja o registro do app." } };
}

/** Frase curta do que o xodó quer fazer ("Escrever o arquivo notas.txt"), para a tela de aprovação. */
function withSummary<T extends { tool_name: string; input: unknown }>(rows: T[]): (T & { resumo: string })[] {
  return rows.map((row) => {
    const tool = TOOLS_BY_NAME.get(row.tool_name) ?? NATIVE_APP_TOOLS.find((t) => t.name === row.tool_name);
    let resumo = row.tool_name;
    try {
      if (tool) resumo = tool.summarize(row.input as never);
    } catch {}
    return { ...row, resumo };
  });
}

const who = (c: Ctx) => ({ userId: c.state.userId, manage: true });

async function xodoOf(c: Ctx, id: string) {
  const xodo = await loadXodo(c.deps.sql, uuid.parse(id), c.state.ownerId);
  return xodo;
}

/** Visão geral para a tela inicial: seus xodós, o que espera você e o gasto de hoje. */
async function overview(c: Ctx) {
  const sql: Sql = c.deps.sql;
  const owner = c.state.ownerId;
  const [xodos, pending, unread, credentials] = await Promise.all([
    sql.query(
      `select x.id, x.name, x.species, x.color, x.personality, x.role, x.instructions, x.autonomy, x.provider, x.model, x.credential_id,
              x.daily_budget_brl::float8 as daily_budget_brl, x.status, x.memory_enabled, x.created_at::text,
              coalesce((select b.spent_brl::float8 from xodo_budget_days b where b.xodo_id = x.id and b.day = (now() at time zone x.timezone)::date), 0) as spent_today_brl,
              (select count(*)::int from xodo_actions a where a.xodo_id = x.id and a.status = 'pending') as pending,
              (select coalesce(json_agg(json_build_object('app', p.app, 'connection_id', p.connection_id) order by p.app), '[]'::json)
                 from xodo_apps p where p.xodo_id = x.id) as apps,
              (select json_build_object('id', r.id, 'status', r.status, 'error', r.error, 'started_at', r.started_at::text)
                 from xodo_runs r where r.xodo_id = x.id order by r.started_at desc limit 1) as last_run
         from xodos x where x.agency_id = $1 order by x.created_at`,
      [owner],
    ),
    sql.query<{ n: number }>(`select count(*)::int as n from xodo_actions where agency_id = $1 and status = 'pending'`, [owner]),
    sql.query<{ n: number }>(`select count(*)::int as n from notifications where agency_id = $1 and read_at is null`, [owner]),
    listCredentials(sql, owner),
  ]);
  return {
    nome: c.state.settings.nome,
    pasta: c.state.settings.pasta,
    xodos,
    aprovacoes_pendentes: pending[0]?.n ?? 0,
    avisos_nao_lidos: unread[0]?.n ?? 0,
    chaves: credentials,
  };
}

const settingsInput = z.object({ nome: z.string().trim().max(60).optional(), pasta: z.string().trim().min(3).max(400).optional() });
const messageInput = z.object({ text: z.string().trim().min(1).max(8000) });
const decisionInput = z.object({ approve: z.boolean(), scope: z.enum(["once", "always"]).default("once"), reason: z.string().max(500).optional() });
const routineInput = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4000),
  cron: z.string().trim().min(9).max(100),
  continuity: z.boolean().optional(),
});

export async function handle(c: Ctx, req: Req): Promise<Res> {
  const { method, path, query, body } = req;
  const sql = c.deps.sql;
  const owner = c.state.ownerId;
  const seg = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  try {
    // ---- visão geral e configurações
    if (seg[0] === "estado" && method === "GET") return ok(await overview(c));
    if (seg[0] === "configuracoes" && method === "PUT") {
      const input = settingsInput.parse(body);
      const next = { ...c.state.settings, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
      if (input.pasta) await setFilesRoot(input.pasta).catch(() => { throw new XodoError("Não consegui usar essa pasta. Confira o caminho."); });
      writeSettings(c.state.dataDir, next);
      c.state.settings = next;
      if (input.nome !== undefined) await ensureOwner(sql, input.nome);
      return ok({ ok: true, ...next });
    }

    // ---- modelos de IA e chaves
    if (seg[0] === "catalogo" && method === "GET") {
      const llm = serverLlm();
      const provider = query.get("provider");
      return ok(provider ? { provider, models: llm.models(provider) } : { providers: llm.providers() });
    }
    if (seg[0] === "chaves") {
      if (method === "GET") return ok({ chaves: await listCredentials(sql, owner) });
      if (method === "POST") {
        const cred = await createCredential(sql, serverLlm(), owner, body, c.state.userId, c.state.masterKey, undefined, globalThis.fetch.bind(globalThis));
        return ok({ chave: cred }, 201);
      }
      if (method === "DELETE" && seg[1]) {
        await revokeCredential(sql, owner, uuid.parse(seg[1]));
        return ok({ ok: true });
      }
    }

    // ---- integrações (Google) e canais (Telegram, WhatsApp)
    if (seg[0] === "integracoes") {
      const integ = integrationsOf(c);
      if (!seg[1] && method === "GET") {
        return ok({
          google: { configurado: googleConfigured(), volta: `${integ.appUrl}/api/integrations/google/callback` },
          contas: (await connections(integ, owner)).filter((r) => r.provider === "google"),
          canais: await c.channels.list(),
          webhook_whatsapp: `${integ.appUrl}/webhook/whatsapp`,
        });
      }
      if (seg[1] === "google" && seg[2] === "app" && method === "PUT") {
        await saveGoogleClient(c.state.dataDir, c.state.masterKey, body);
        return ok({ ok: true });
      }
      if (seg[1] === "google" && seg[2] === "conectar" && method === "POST") {
        return ok({ url: await startGoogleLogin(integ, owner, c.state.userId, body) });
      }
      if (seg[1] && !seg[2] && method === "DELETE") {
        await disconnect(integ, owner, uuid.parse(seg[1]));
        await c.channels.refresh();
        return ok({ ok: true });
      }
    }
    if (seg[0] === "canais") {
      if (seg[1] === "telegram" && method === "POST") return ok(await c.channels.connectTelegram(body), 201);
      if (seg[1] === "whatsapp" && method === "POST") return ok(await c.channels.connectWhatsapp(body), 201);
      const id = uuid.parse(seg[1]);
      if (!seg[2] && method === "PATCH") {
        await c.channels.update(id, body);
        return ok({ ok: true });
      }
      if (seg[2] === "codigo" && method === "POST") return ok(await c.channels.pairingCode(id));
      if (seg[2] === "teste" && method === "POST") {
        await c.channels.test(id);
        return ok({ ok: true });
      }
    }

    // ---- aprovações (de todos os xodós)
    if (seg[0] === "aprovacoes") {
      if (method === "GET" && !seg[1]) {
        return ok({
          aprovacoes: withSummary(await sql.query<{ tool_name: string; input: unknown }>(
            `select a.id, a.run_id, a.xodo_id, x.name as xodo_name, x.species, x.color, a.tool_name, a.category, a.input, a.reason,
                    a.expires_at::text, a.created_at::text
               from xodo_actions a join xodos x on x.id = a.xodo_id
              where a.agency_id = $1 and a.status = 'pending' order by a.created_at`,
            [owner],
          )),
        });
      }
      if (method === "POST" && seg[1]) {
        const d = decisionInput.parse(body);
        const result = await decideAction(c.deps, { actionId: uuid.parse(seg[1]), agencyId: owner, userId: c.state.userId, ...d });
        void c.worker.afterDecision(result.runId);
        return ok(result);
      }
    }

    // ---- avisos (o sino)
    if (seg[0] === "avisos") {
      if (method === "GET") {
        return ok({
          avisos: await sql.query(
            `select id, kind, title, body, data, created_at::text, read_at::text from notifications where agency_id = $1 order by created_at desc limit 50`,
            [owner],
          ),
        });
      }
      if (method === "POST" && seg[1] === "lidos") {
        await sql.query(`update notifications set read_at = now() where agency_id = $1 and read_at is null`, [owner]);
        return ok({ ok: true });
      }
    }

    // ---- xodós
    if (seg[0] === "xodos") {
      if (!seg[1] && method === "POST") return ok({ xodo: await createXodo(sql, serverLlm(), owner, body, c.state.userId) }, 201);
      if (!seg[1]) return ok({ xodos: (await overview(c)).xodos });
      const xodo = await xodoOf(c, seg[1]);
      const sub = seg[2];

      if (!sub && method === "PATCH") return ok({ xodo: await updateXodo(sql, serverLlm(), owner, xodo.id, body) });
      if (!sub && method === "DELETE") {
        await deleteXodo(sql, owner, xodo.id, query.get("confirmar") ?? "");
        return ok({ ok: true });
      }

      if (sub === "conversa" && method === "GET") {
        const [messages, pending, runs] = await Promise.all([
          sql.query(
            `select * from (select id, run_id, role, text, created_at::text from xodo_messages
               where xodo_id = $1 and agency_id = $2 and conversation_id is null order by id desc limit 80) m order by id`,
            [xodo.id, owner],
          ),
          sql.query(
            `select id, run_id, tool_name, category, input, reason, expires_at::text, created_at::text from xodo_actions
              where xodo_id = $1 and agency_id = $2 and status = 'pending' order by created_at`,
            [xodo.id, owner],
          ),
          sql.query(
            `select id, status, steps, error, started_at::text, finished_at::text from xodo_runs
              where xodo_id = $1 and agency_id = $2 order by started_at desc limit 1`,
            [xodo.id, owner],
          ),
        ]);
        return ok({ mensagens: messages, pendentes: withSummary(pending as { tool_name: string; input: unknown }[]), ultima_execucao: runs[0] ?? null });
      }
      if (sub === "mensagens" && method === "POST") {
        const { text } = messageInput.parse(body);
        const runId = await startRun(c.deps, { xodoId: xodo.id, agencyId: owner, trigger: "user", text, userId: c.state.userId });
        void c.worker.drive(runId);
        return ok({ run_id: runId }, 202);
      }

      if (sub === "rotinas") {
        if (method === "GET") {
          return ok({
            rotinas: await sql.query(
              `select id, name, prompt, cron, timezone, active, continuity, last_summary, last_run_at::text, next_run_at::text
                 from xodo_routines where xodo_id = $1 and agency_id = $2 order by created_at`,
              [xodo.id, owner],
            ),
          });
        }
        if (method === "POST") {
          const input = routineInput.parse(body);
          return ok({ rotina: await createRoutine(sql, { ...input, timezone: xodo.timezone, agencyId: owner, xodoId: xodo.id, createdBy: c.state.userId }) }, 201);
        }
        const routineId = uuid.parse(seg[3]);
        if (method === "PATCH") {
          const { active } = z.object({ active: z.boolean() }).parse(body);
          const row = await one<{ cron: string; timezone: string }>(sql, `select cron, timezone from xodo_routines where id = $1 and xodo_id = $2`, [routineId, xodo.id]);
          if (!row) throw new XodoError("Rotina não encontrada", 404);
          const next = active ? nextRunAt(row.cron, row.timezone, new Date()) : null;
          await sql.query(`update xodo_routines set active = $2, next_run_at = coalesce($3::timestamptz, next_run_at) where id = $1`, [routineId, active, next?.toISOString() ?? null]);
          return ok({ ok: true });
        }
        if (method === "DELETE") {
          const row = await one(sql, `delete from xodo_routines where id = $1 and xodo_id = $2 returning id`, [routineId, xodo.id]);
          if (!row) throw new XodoError("Rotina não encontrada", 404);
          return ok({ ok: true });
        }
      }

      if (sub === "memoria") {
        if (!seg[3] && method === "GET") return ok(await listMemory(sql, xodo, Object.fromEntries(query)));
        if (!seg[3] && method === "POST") {
          const result = await createNote(sql, xodo, body, who(c));
          return ok(result, result.criada ? 201 : 200);
        }
        const n = z.coerce.number().int().positive().parse(seg[3]);
        if (method === "PATCH") return ok(await editNote(sql, xodo, n, body, who(c)));
        if (method === "DELETE") {
          return ok(await deleteNote(sql, xodo, n, Object.fromEntries(query), who(c)));
        }
      }
    }
    return { status: 404, body: { error: "Caminho não encontrado." } };
  } catch (error) {
    return failure(error);
  }
}
