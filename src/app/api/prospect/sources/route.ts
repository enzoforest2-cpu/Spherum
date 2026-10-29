import { NextResponse } from "next/server";
import { z } from "zod";
import { connectSourceKey, listGroups, searchCnae, searchCnpj, searchGroup, searchInstagram, searchMaps, sourcesStatus } from "@/lib/core/prospect-sources";
import { requireFeature } from "@/lib/core/platform";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/**
 * Fontes da Prospecção. A busca só devolve candidatos; importar é em POST /api/prospect/leads.
 *
 * GET  /api/prospect/sources?agency_id=…              quais fontes estão prontas
 * GET  /api/prospect/sources?agency_id=…&cnae=texto   atividades (CNAE) pelo nome ou código
 * POST /api/prospect/sources  { agency_id, fonte, ... }
 *   chave:     { source: maps | cnpj, key }       guarda a chave (quem edita Vendas)
 *   maps:      { query, city, page_token? }
 *   cnpj:      { cnae[], uf, city?, mobile_only?, with_email?, limit?, token? }
 *   instagram: { usernames[] }
 *   grupos:    {}                                  grupos dos números ligados por QR Code
 *   grupo:     { connection_id, group_id, group_name }
 */
// A CNPJá e o gateway do WhatsApp podem demorar.
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const url = new URL(request.url);
    const agencyId = uuid.parse(url.searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_USE, { area: "comercial" });
    const cnae = url.searchParams.get("cnae");
    if (cnae != null) return NextResponse.json({ cnae: await searchCnae({ sql, ...serverIntegrations() }, cnae) });
    return NextResponse.json(await sourcesStatus(sql, agencyId));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, fonte, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const kind = z.enum(["chave", "maps", "cnpj", "instagram", "grupos", "grupo"]).parse(fonte);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, kind === "chave" ? CAN_MANAGE : CAN_USE, { area: "comercial" });
    await requireFeature(sql, "prospect");
    const deps = { sql, ...serverIntegrations() };
    switch (kind) {
      case "chave":
        return NextResponse.json(await connectSourceKey(deps, agencyId, userId, input), { status: 201 });
      case "maps":
        return NextResponse.json(await searchMaps(deps, agencyId, input));
      case "cnpj":
        return NextResponse.json(await searchCnpj(deps, agencyId, input));
      case "instagram":
        return NextResponse.json(await searchInstagram(deps, agencyId, input));
      case "grupos":
        return NextResponse.json({ numbers: await listGroups(deps, agencyId) });
      case "grupo":
        return NextResponse.json(await searchGroup(deps, agencyId, input));
    }
  } catch (error) {
    return fail(error);
  }
}
