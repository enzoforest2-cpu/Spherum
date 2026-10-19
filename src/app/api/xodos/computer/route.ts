import { after, NextResponse } from "next/server";
import { ADAPTERS } from "@/lib/channels";
import { deliverRun } from "@/lib/channels/manage";
import type { ChannelDeps } from "@/lib/channels/types";
import { computerDeps } from "@/lib/computer";
import { withEngine } from "@/lib/computer/control";
import { configure, destroy, getComputerState } from "@/lib/computer/manage";
import { productionDeps } from "@/lib/xodos";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

export const maxDuration = 300;

/** GET /api/xodos/computer?agency_id=…  estado do card (sem id no provedor nem hash de token). */
export async function GET(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    return NextResponse.json(await getComputerState({ sql }, agencyId, userId));
  } catch (error) {
    return fail(error);
  }
}

/** PUT { agency_id, provider, credential_id?, idle_minutes?, daily_hours_cap?, egress_mode? } */
export async function PUT(request: Request) {
  try {
    const userId = await requireUser(request);
    const body = await request.json();
    const agencyId = uuid.parse(body?.agency_id ?? new URL(request.url).searchParams.get("agency_id"));
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_MANAGE);
    const { agency_id: _agency, ...input } = body ?? {};
    void _agency;
    return NextResponse.json(await configure(computerDeps(sql), agencyId, userId, input));
  } catch (error) {
    return fail(error);
  }
}

/** DELETE ?agency_id=…  desliga de vez e apaga a máquina (só o dono da agência). */
export async function DELETE(request: Request) {
  try {
    const userId = await requireUser(request);
    const agencyId = uuid.parse(new URL(request.url).searchParams.get("agency_id"));
    const engine = await productionDeps();
    await requireRole(engine.sql, userId, agencyId, ["owner"]);
    const deps = withEngine(computerDeps(engine.sql), engine, (runId, task) =>
      after(async () => {
        try {
          await task();
        } catch (error) {
          console.error("[computador] retomada falhou", runId, error);
        } finally {
          await deliverRun(engine as ChannelDeps, ADAPTERS, runId).catch((error) => console.error("[canais] entrega falhou", runId, error));
        }
      }),
    );
    await destroy(deps, agencyId, userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return fail(error);
  }
}
