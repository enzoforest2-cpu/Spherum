import { NextResponse } from "next/server";
import { fail, requireUser } from "@/lib/xodos/http";
import { serverLlm } from "@/lib/xodos/llm";

/**
 * GET /api/xodos/catalog            provedores disponíveis no passo "Cérebro"
 * GET /api/xodos/catalog?provider=  modelos do provedor, com janela de contexto e preço (US$ por milhão de tokens)
 */
export async function GET(request: Request) {
  try {
    await requireUser(request);
    const llm = serverLlm();
    const provider = new URL(request.url).searchParams.get("provider");
    if (provider) return NextResponse.json({ provider, models: llm.models(provider) });
    return NextResponse.json({ providers: llm.providers() });
  } catch (error) {
    return fail(error);
  }
}
