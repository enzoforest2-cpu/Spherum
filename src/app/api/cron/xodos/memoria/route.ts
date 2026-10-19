import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { productionDeps } from "@/lib/xodos";
import { fail } from "@/lib/xodos/http";
import { processDueCaptures } from "@/lib/xodos/memory/capture";
import { pruneMemoryHistory, tidyDueMemories } from "@/lib/xodos/memory/upkeep";

export const maxDuration = 300;

const failed = (error: unknown) => `falhou: ${error instanceof Error ? error.message : String(error)}`;

/**
 * GET /api/cron/xodos/memoria  com "Authorization: Bearer $CRON_SECRET".
 * Roda as capturas de memória vencidas (o que os xodós aprenderam nas conversas), a arrumação
 * noturna e a retenção do histórico da memória. Chame a cada 15 minutos, como /api/cron/xodos.
 */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    const given = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${secret}`;
    if (!secret || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }
    const deps = await productionDeps();
    // Prazo interno abaixo do maxDuration: nenhuma etapa começa uma chamada que não daria tempo de terminar.
    const deadline = Date.now() + 240_000;
    // Uma etapa falhando não impede as outras.
    const capturas = await processDueCaptures(deps, { limit: 8, deadline }).catch(failed);
    const arrumacao = await tidyDueMemories(deps, { limit: 3, deadline }).catch(failed);
    const retencao = await pruneMemoryHistory(deps.sql, new Date()).catch(failed);
    return NextResponse.json({ capturas, arrumacao, retencao });
  } catch (error) {
    return fail(error);
  }
}
