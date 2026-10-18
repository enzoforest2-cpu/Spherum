import { z } from "zod";
import { assertPublicUrl, type Resolver } from "../xodos/net";
import { IntegrationError } from "./http";
import { listMcpTools } from "./mcp";
import { saveConnection, type IntegrationDeps } from "./store";

/**
 * Conexões que não usam OAuth: a agência informa endereço e chave. Cada tipo valida na hora
 * (o servidor responde de verdade) antes de gravar.
 */

export const mcpInput = z.object({
  provider: z.literal("mcp"),
  label: z.string().trim().min(1).max(60),
  url: z.string().trim().max(500),
  token: z.string().trim().max(2000).optional(),
});

export async function createMcpConnection(
  deps: IntegrationDeps,
  agencyId: string,
  raw: unknown,
  createdBy: string | null,
  resolve?: Resolver,
) {
  const input = mcpInput.parse(raw);
  let url: string;
  try {
    url = (await assertPublicUrl(input.url, resolve)).toString();
  } catch (error) {
    throw new IntegrationError(error instanceof Error ? error.message : "Endereço inválido.", 400);
  }
  // Confere que o servidor responde e lista as ferramentas antes de gravar.
  const tools = await listMcpTools(url, input.token, deps.fetch);
  const id = await saveConnection(deps, {
    agencyId,
    provider: "mcp",
    label: input.label,
    account: url,
    secret: { apiKey: input.token ?? "" },
    metadata: { url, tools: tools.map((t) => ({ name: t.name, category: t.category })) },
    createdBy,
  });
  return { id, tools: tools.map((t) => ({ name: t.name, category: t.category })) };
}
