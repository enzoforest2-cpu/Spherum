import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { createCredential, listCredentials, revokeCredential } from "@/lib/xodos";
import { serverLlm } from "@/lib/xodos/llm";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

/** Chaves de API da agência. A chave entra uma vez e nunca mais sai: só os 4 últimos dígitos. */

export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "xodos" });
    return NextResponse.json({ credentials: await listCredentials(sql, agencyId) });
  } catch (error) {
    return fail(error);
  }
}

/** POST { agency_id, provider, label, api_key, base_url? }  (base_url para "local" e "custom") */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "xodos" });
    const credential = await createCredential(sql, serverLlm(), agencyId, body, userId, masterKeyFromEnv(), undefined, globalThis.fetch.bind(globalThis));
    return NextResponse.json({ credential }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE ?agency_id=…&id=…  revoga (os xodós que usam a chave param de rodar). */
export async function DELETE(request: Request) {
  try {
    const userId = await requireUser(request);
    const search = new URL(request.url).searchParams;
    const agencyId = uuid.parse(search.get("agency_id"));
    const credentialId = uuid.parse(search.get("id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE, { area: "xodos" });
    await revokeCredential(sql, agencyId, credentialId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
