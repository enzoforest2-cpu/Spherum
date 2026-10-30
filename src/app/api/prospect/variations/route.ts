import { NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature } from "@/lib/core/platform";
import { generateVariations, submitVariation, syncVariations } from "@/lib/core/prospect-variations";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { serverLlm } from "@/lib/xodos/llm";

/**
 * Disparos com variação automática.
 *
 * POST /api/prospect/variations { agency_id, acao, ... }
 *   gerar:       { base, count?, tone? }     a IA escreve as variações (não grava nada)
 *   enviar:      { waba_id, style, text }    manda para a Meta aprovar e guarda desligada
 *   sincronizar: {}                          confere na Meta e liga as aprovadas
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, acao, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const kind = z.enum(["gerar", "enviar", "sincronizar"]).parse(acao);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
    await requireFeature(sql, "prospect");
    const integrations = { sql, ...serverIntegrations() };
    const deps = { sql, llm: serverLlm(), masterKey: integrations.masterKey, integrations };
    if (kind === "gerar") return NextResponse.json(await generateVariations(deps, agencyId, input));
    if (kind === "enviar") return NextResponse.json(await submitVariation(deps, agencyId, input), { status: 201 });
    return NextResponse.json(await syncVariations(deps, agencyId));
  } catch (error) {
    return fail(error);
  }
}
