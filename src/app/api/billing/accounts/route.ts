import { NextResponse } from "next/server";
import { billingDepsFromEnv, connectAccount, listAccounts, providerCatalog } from "@/lib/billing";
import { serverSql } from "@/lib/xodos/db";
import { CAN_BILL, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { masterKeyFromEnv } from "@/lib/xodos/vault";

/** GET /api/billing/accounts?agency_id=…  contas de pagamento conectadas e os provedores disponíveis. */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    return NextResponse.json({ accounts: await listAccounts(sql, agencyId), providers: providerCatalog() });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/billing/accounts  { agency_id, provider, environment, credentials }  conecta (ou troca a chave de) um meio de pagamento. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id, ...input } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_BILL);
    return NextResponse.json(await connectAccount(billingDepsFromEnv(sql, masterKeyFromEnv()), agencyId, userId, input), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
