import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { fromPGlite, one, type Sql } from "../src/lib/xodos/db";
import type { ModelDriver, StepRequest, StepResponse, Turn } from "../src/lib/xodos/providers";
import type { EngineDeps } from "../src/lib/xodos/runner";
import type { ToolCall, ToolResult, Usage, Xodo } from "../src/lib/xodos/types";

// Os testes rodam da raiz do repositório (npm test).
const FOUNDATION = readFileSync("tests/fixtures/foundation.sql", "utf8");
const MIGRATION = readFileSync("supabase/migrations/20261018120000_xodos.sql", "utf8");

export async function createTestDb(): Promise<{ db: PGlite; sql: Sql }> {
  const db = new PGlite();
  await db.exec(FOUNDATION);
  await db.exec(MIGRATION);
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
    `insert into ai_credentials (agency_id, provider, label, ciphertext, key_last4) values ($1, 'anthropic', 'Teste', 'v1:x', 'abcd') returning id`,
    [agencyId],
  );
  const values = {
    name: "Faísca",
    species: "pingo",
    personality: "curioso",
    role: "relatorios",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    credential_id: credential!.id,
    daily_budget_usd: 5,
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
// Modelo falso: segue um roteiro de passos e guarda o que recebeu
// ---------------------------------------------------------------------------

export type ScriptStep =
  | { text?: string; toolCalls?: ToolCall[]; stop?: StepResponse["stop"]; usage?: Partial<Usage> }
  | ((req: StepRequest) => { text?: string; toolCalls?: ToolCall[]; stop?: StepResponse["stop"]; usage?: Partial<Usage> });

export type FakeMessage =
  | { role: "user" | "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export class FakeModel {
  requests: StepRequest[] = [];
  private cursor = 0;
  constructor(private script: ScriptStep[]) {}

  driver(model = "claude-sonnet-5-5"): ModelDriver {
    return {
      provider: "anthropic",
      model,
      start: (turns: Turn[]) => turns.map((t) => ({ role: t.role, text: t.text })),
      step: async (req) => {
        this.requests.push(structuredClone(req));
        const entry = this.script[this.cursor++];
        if (!entry) throw new Error(`roteiro acabou no passo ${this.cursor}`);
        const out = typeof entry === "function" ? entry(req) : entry;
        const toolCalls = out.toolCalls ?? [];
        return {
          history: [...req.history, { role: "assistant", text: out.text ?? "", toolCalls }],
          text: out.text ?? "",
          toolCalls,
          stop: out.stop ?? (toolCalls.length ? "tool_use" : "end"),
          usage: [{ model, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, ...out.usage } }],
        };
      },
      addToolResults: (history, results) => [...history, { role: "tool", results }],
    };
  }

  /** Último bloco de resultados de ferramenta que o modelo recebeu. */
  lastToolResults(): ToolResult[] {
    const history = this.requests[this.requests.length - 1].history as FakeMessage[];
    const last = [...history].reverse().find((m) => m.role === "tool");
    return last && last.role === "tool" ? last.results : [];
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
  return { sql, now: clock.now, driverFor: async (xodo) => model.driver(xodo.model) };
}
