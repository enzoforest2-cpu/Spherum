import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { after } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Message,
  type Tool,
} from "@earendil-works/pi-ai";
import { PGlite } from "@electric-sql/pglite";
import { fromPGlite, fromPostgres, one, POSTGRES_TYPES, type Sql } from "../src/lib/xodos/db";
import { llmFromModels, type LlmClient } from "../src/lib/xodos/llm";
import type { EngineDeps } from "../src/lib/xodos/runner";
import type { ToolCall, ToolResult, Xodo } from "../src/lib/xodos/types";

// Os testes rodam da raiz do repositório (npm test).
const FOUNDATION = readFileSync("tests/fixtures/foundation.sql", "utf8");
const MIGRATIONS = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"));

/**
 * Com TEST_PG_URL (ex.: postgres://postgres@127.0.0.1:5499/postgres), cada banco de teste é um
 * banco novo num Postgres de verdade, usando o mesmo driver e as mesmas opções da produção. Pega
 * diferenças que o PGlite esconde (como a serialização de jsonb do driver).
 */
const openClients: { end(): Promise<void> }[] = [];
if (process.env.TEST_PG_URL) after(() => Promise.all(openClients.map((c) => c.end())));

async function createRealDb(admin: string): Promise<{ db: PGlite; sql: Sql }> {
  const { default: postgres } = await import("postgres");
  const name = `t_${randomUUID().replace(/-/g, "")}`;
  const root = postgres(admin, { max: 1, onnotice: () => {} });
  await root.unsafe(`create database ${name}`);
  await root.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  // Uma conexão só: os testes de RLS trocam de papel (set role) e esperam continuar nela.
  const client = postgres(url.toString(), { prepare: false, max: 1, types: POSTGRES_TYPES, onnotice: () => {} });
  openClients.push(client);
  await client.unsafe(FOUNDATION);
  for (const migration of MIGRATIONS) await client.unsafe(migration);
  const sql = fromPostgres(client as never);
  // O que os testes usam do PGlite diretamente: query (com rows) e exec.
  const db = {
    query: async (text: string, params: unknown[] = []) => ({ rows: [...(await client.unsafe(text, params as never[]))] }),
    exec: async (text: string) => { await client.unsafe(text); },
  } as unknown as PGlite;
  return { db, sql };
}

export async function createTestDb(): Promise<{ db: PGlite; sql: Sql }> {
  if (process.env.TEST_PG_URL) return createRealDb(process.env.TEST_PG_URL);
  const db = new PGlite();
  await db.exec(FOUNDATION);
  for (const migration of MIGRATIONS) await db.exec(migration);
  return { db, sql: fromPGlite(db) };
}

export async function seedAgency(sql: Sql, name = "Agência Teste") {
  const agency = await one<{ id: string }>(sql, `insert into agencies (name) values ($1) returning id`, [name]);
  const owner = randomUUID();
  await sql.query(`insert into agency_members (agency_id, user_id, role) values ($1, $2, 'owner')`, [agency!.id, owner]);
  return { agencyId: agency!.id, ownerId: owner };
}

export async function seedClient(sql: Sql, agencyId: string, name: string) {
  const row = await one<{ id: string }>(sql, `insert into clients (agency_id, name) values ($1, $2) returning id`, [agencyId, name]);
  return row!.id;
}

export async function seedXodo(sql: Sql, agencyId: string, overrides: Partial<Record<keyof Xodo, unknown>> = {}): Promise<Xodo> {
  const credential = await one<{ id: string }>(
    sql,
    `insert into ai_credentials (agency_id, provider, label, ciphertext, key_last4) values ($1, 'faux', 'Teste', 'v1:x', 'abcd') returning id`,
    [agencyId],
  );
  const values = {
    name: "Pipoca",
    species: "pingo",
    color: "Tomate",
    personality: "curioso",
    provider: "faux",
    model: "faux-1",
    credential_id: credential!.id,
    ...overrides,
  };
  const keys = Object.keys(values);
  const xodo = await one<Xodo>(
    sql,
    `insert into xodos (agency_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning *`,
    [agencyId, ...Object.values(values)],
  );
  return xodo!;
}

export async function seedMetrics(sql: Sql, agencyId: string, clientId: string, rows: Record<string, unknown>[]) {
  for (const r of rows) {
    await sql.query(
      `insert into metrics_daily (agency_id, client_id, platform, account_id, campaign_id, campaign_name, day,
         spend_cents, impressions, clicks, leads, conversions, revenue_cents)
       values ($1, $2, $3, 'act_1', $4, $5, $6::date, $7, $8, $9, $10, $11, $12)`,
      [agencyId, clientId, r.platform ?? "meta", r.campaign_id ?? "c1", r.campaign_name ?? "Campanha 1", r.day,
        r.spend_cents ?? 0, r.impressions ?? 0, r.clicks ?? 0, r.leads ?? 0, r.conversions ?? 0, r.revenue_cents ?? 0],
    );
  }
}

// ---------------------------------------------------------------------------
// Modelo falso: provedor "faux" da pi-ai seguindo um roteiro, guardando o que recebeu
// ---------------------------------------------------------------------------

/** Preço dos modelos falsos (US$ por milhão de tokens), para o gasto não ser zero. */
export const FAUX_COST = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

type Reply = { text?: string; toolCalls?: ToolCall[]; stop?: "stop" | "length" | "toolUse"; error?: string; refusal?: boolean };
export type ScriptStep = Reply | ((req: FakeRequest) => Reply);

export type FakeRequest = { model: string; system: string; tools: Tool[]; messages: Message[] };

export class FakeModel {
  requests: FakeRequest[] = [];
  readonly llm: LlmClient;
  private cursor = 0;

  constructor(private script: ScriptStep[]) {
    const models = createModels();
    const faux = fauxProvider({
      provider: "faux",
      models: [
        { id: "faux-1", cost: FAUX_COST },
        { id: "faux-2", cost: FAUX_COST },
      ],
    });
    models.setProvider(faux.provider);
    this.llm = llmFromModels(models);
    const step = (context: { messages: Message[] }, _o: unknown, _s: unknown, model: { id: string }): AssistantMessage => {
      const [system, ...rest] = context.messages;
      const sys = system?.role === "system" ? system : null;
      const request: FakeRequest = {
        model: model.id,
        system: typeof sys?.content === "string" ? sys.content : (sys?.content ?? []).map((c) => c.text).join(""),
        tools: sys?.toolsAdded ?? [],
        messages: sys ? rest : context.messages,
      };
      this.requests.push(structuredClone(request));
      const entry = this.script[this.cursor++];
      if (!entry) return fauxAssistantMessage("roteiro acabou", { stopReason: "error", errorMessage: "roteiro acabou" });
      const out = typeof entry === "function" ? entry(request) : entry;
      if (out.refusal) {
        return { ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "recusou" }), rawStopReason: "refusal" };
      }
      if (out.error) return fauxAssistantMessage("", { stopReason: "error", errorMessage: out.error });
      const calls = (out.toolCalls ?? []).map((c) => fauxToolCall(c.name, c.input as Record<string, never>, { id: c.id }));
      const content = [...(out.text ? [fauxText(out.text)] : []), ...calls];
      return fauxAssistantMessage(content.length ? content : "", { stopReason: out.stop ?? (calls.length ? "toolUse" : "stop") });
    };
    faux.setResponses(Array.from({ length: 200 }, () => step as never));
  }

  /** Último bloco de resultados de ferramenta que o modelo recebeu. */
  lastToolResults(): ToolResult[] {
    const messages = this.requests[this.requests.length - 1].messages;
    let i = messages.length - 1;
    const results: ToolResult[] = [];
    while (i >= 0 && messages[i].role === "toolResult") {
      const m = messages[i] as Extract<Message, { role: "toolResult" }>;
      results.unshift({ id: m.toolCallId, name: m.toolName, isError: m.isError, content: m.content.map((c) => ("text" in c ? c.text : "")).join("") });
      i -= 1;
    }
    return results;
  }
}

export class Clock {
  constructor(public current = new Date("2026-10-19T12:00:00Z")) {}
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function testDeps(sql: Sql, model: FakeModel, clock = new Clock()): EngineDeps {
  return {
    sql,
    now: clock.now,
    llm: model.llm,
    secretFor: async (agencyId, credentialId) => {
      const row = await one<{ provider: string; base_url: string | null }>(
        sql,
        `select provider, base_url from ai_credentials where id = $1 and agency_id = $2 and revoked_at is null`,
        [credentialId, agencyId],
      );
      if (!row) throw new Error("chave revogada");
      return { provider: row.provider, apiKey: "chave-de-teste", baseUrl: row.base_url };
    },
  };
}

/** Cotação fixa para os testes (R$ 5,50 por dólar). */
export async function seedFx(sql: Sql, day = "2026-10-16", rate = 5.5) {
  await sql.query(`insert into fx_rates (day, usd_brl) values ($1::date, $2) on conflict (day) do update set usd_brl = $2`, [day, rate]);
}
