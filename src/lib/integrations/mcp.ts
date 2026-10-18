import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { classifyExternalTool } from "./classify";
import { IntegrationError, type Fetch } from "./http";
import type { Category } from "../xodos/policy";

/**
 * Servidores MCP genéricos (Streamable HTTP com token), como no OpenDots: a agência cadastra
 * a URL e o token, e as ferramentas do servidor viram ferramentas do xodó. A categoria de
 * cada uma sai do classificador, então a aprovação segue a autonomia escolhida.
 */

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: Category;
};

const CALL_TIMEOUT_MS = 60_000;

async function withClient<T>(url: string, token: string | undefined, http: Fetch, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "spherum-xodos", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    fetch: http,
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new IntegrationError(`Servidor MCP falhou: ${message.slice(0, 300)}`, 502, /401|unauthori[sz]ed/i.test(message));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listMcpTools(url: string, token: string | undefined, http: Fetch): Promise<McpTool[]> {
  return withClient(url, token, http, async (client) => {
    const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    return tools.map((t) => ({
      name: t.name,
      description: (t.description ?? t.title ?? t.name).slice(0, 1000),
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      category: classifyExternalTool(t.name, t.annotations ?? {}),
    }));
  });
}

export async function callMcpTool(url: string, token: string | undefined, http: Fetch, name: string, args: unknown) {
  return withClient(url, token, http, async (client) => {
    const result = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: CALL_TIMEOUT_MS });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : JSON.stringify(c))).join("\n");
    if (result.isError) throw new IntegrationError(text.slice(0, 500) || "O servidor MCP devolveu erro.", 502);
    return result.structuredContent ?? text;
  });
}
