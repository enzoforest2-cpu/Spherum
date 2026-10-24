import { NextResponse } from "next/server";
import { serverIntegrations } from "@/lib/integrations";
import { IntegrationError } from "@/lib/integrations/http";
import { finishOAuth } from "@/lib/integrations/oauth";
import { XodoError } from "@/lib/xodos/errors";
import { serverSql } from "@/lib/xodos/db";

/** Volta do login na plataforma. Termina sempre num redirecionamento para o Spherum, com o resultado na URL. */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const search = new URL(request.url).searchParams;
  const deps = { sql: await serverSql(), ...serverIntegrations() };
  const back = (path: string, query: Record<string, string>) =>
    NextResponse.redirect(`${deps.appUrl}${path}?${new URLSearchParams({ integracao: provider, ...query })}`);
  try {
    const result = await finishOAuth(deps, {
      provider,
      // O TikTok devolve auth_code; os outros, code.
      code: search.get("code") ?? search.get("auth_code"),
      state: search.get("state"),
      error: search.get("error_description") ?? search.get("error"),
    });
    return back(result.returnTo, { status: "ok", conexao: result.connectionId });
  } catch (error) {
    console.error("[integrações] login falhou", provider, error);
    // Só a mensagem de erros esperados (IntegrationError) volta na URL; o resto fica no log.
    const known = error instanceof IntegrationError || error instanceof XodoError;
    if (!known) console.error("[oauth] retorno falhou", error);
    return back("/agencia", { status: "erro", mensagem: known ? error.message.slice(0, 200) : "Não consegui concluir a conexão. Tente de novo." });
  }
}
