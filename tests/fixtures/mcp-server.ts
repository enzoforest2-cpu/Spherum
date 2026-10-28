import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** Servidor MCP de verdade (SDK oficial, Streamable HTTP sem sessão) para os testes. */
export async function startMcpServer(token = "token-mcp") {
  const calls: { name: string; args: unknown }[] = [];
  const build = () => {
    const server = new McpServer({ name: "notas", version: "1.0.0" });
    server.registerTool(
      "list_notes",
      { description: "Lista as notas", inputSchema: { query: z.string().optional() }, annotations: { readOnlyHint: true } },
      async (args) => {
        calls.push({ name: "list_notes", args });
        return { content: [{ type: "text", text: "nota 1; nota 2" }] };
      },
    );
    server.registerTool(
      "send_message",
      { description: "Envia uma mensagem", inputSchema: { to: z.string(), text: z.string() } },
      async (args) => {
        calls.push({ name: "send_message", args });
        return { content: [{ type: "text", text: `enviado para ${args.to}` }] };
      },
    );
    server.registerTool(
      "wipe_notes",
      { description: "Apaga tudo", inputSchema: {}, annotations: { destructiveHint: true } },
      async () => {
        calls.push({ name: "wipe_notes", args: {} });
        return { content: [{ type: "text", text: "apagado" }] };
      },
    );
    return server;
  };
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
