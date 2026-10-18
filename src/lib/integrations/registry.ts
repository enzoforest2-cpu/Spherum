import { createHash } from "node:crypto";
import { z } from "zod";
import type { Xodo } from "../xodos/types";
import { ToolError, type ToolDef } from "../xodos/tools";
import { xodoApps } from "./access";
import { ADS_TOOLS } from "./ads/tools";
import { IntegrationError } from "./http";
import { callMcpTool, listMcpTools } from "./mcp";
import { readSecret, type ConnectionRow, type IntegrationDeps } from "./store";

/**
 * Ferramentas que vêm de apps: as dos conectores nativos (cada um registra as suas) e as dos
 * servidores MCP da agência, montadas na hora a partir da lista do servidor.
 */

/** Ferramentas dos conectores nativos. */
export const NATIVE_APP_TOOLS: readonly ToolDef[] = [...ADS_TOOLS];

/** Nome aceito por todos os provedores de modelo: letras, números, _ e -, até 64 caracteres. */
function toolName(prefix: string, name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const full = `${prefix}_${clean}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, 57)}_${hash}`;
}

async function mcpTools(deps: IntegrationDeps, xodo: Pick<Xodo, "id" | "agency_id">): Promise<ToolDef[]> {
  const rows = await deps.sql.query<ConnectionRow>(
    `select * from integration_connections where agency_id = $1 and provider = 'mcp' and status = 'active' order by created_at`,
    [xodo.agency_id],
  );
  const tools: ToolDef[] = [];
  for (const row of rows) {
    const url = String((row.metadata as { url?: unknown })?.url ?? "");
    const prefix = `mcp_${row.label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 10) || "srv"}${row.id.slice(0, 4)}`;
    let list;
    try {
      const secret = await readSecret(deps, row);
      list = { secret, tools: await listMcpTools(url, secret.apiKey, deps.fetch) };
    } catch (error) {
      // Um servidor fora do ar não derruba o xodó; ele só fica sem essas ferramentas.
      console.warn("[integrações] servidor MCP indisponível", row.label, error instanceof Error ? error.message : error);
      continue;
    }
    for (const t of list.tools) {
      tools.push({
        name: toolName(prefix, t.name),
        description: `[${row.label}] ${t.description}`,
        category: t.category,
        app: "mcp",
        input: z.record(z.string(), z.unknown()),
        jsonSchema: t.inputSchema,
        summarize: () => `usar "${t.name}" no servidor ${row.label}`,
        async execute(ctx, input) {
          try {
            return await callMcpTool(url, list.secret.apiKey, ctx.apps?.http ?? deps.fetch, t.name, input);
          } catch (error) {
            if (error instanceof IntegrationError) throw new ToolError(error.message);
            throw error;
          }
        },
      });
    }
  }
  return tools;
}

/** Ferramentas de app liberadas para o xodó: só dos apps em "Pode mexer em". */
export async function appToolsFor(deps: IntegrationDeps | null, xodo: Pick<Xodo, "id" | "agency_id">): Promise<ToolDef[]> {
  if (!deps) return [];
  const allowed = new Set((await xodoApps(deps.sql, xodo)).map((a) => a.app));
  if (!allowed.size) return [];
  const tools = NATIVE_APP_TOOLS.filter((t) => [t.app ?? []].flat().some((app) => allowed.has(app)));
  if (allowed.has("mcp")) tools.push(...(await mcpTools(deps, xodo)));
  return tools;
}
