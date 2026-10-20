import { NextResponse } from "next/server";
import { z } from "zod";
import { one, serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_MANAGE, CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { createRoutine } from "@/lib/xodos";
import { nextRunAt } from "@/lib/xodos/routines";
import { loadXodo } from "@/lib/xodos/runner";

const routineInput = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4000),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().optional(),
  continuity: z.boolean().optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_READ);
    const routines = await sql.query(
      `select id, name, prompt, cron, timezone, active, continuity, last_summary, last_run_at::text, next_run_at::text
         from xodo_routines where xodo_id = $1 and agency_id = $2 order by created_at`,
      [xodoId, xodo.agency_id],
    );
    return NextResponse.json({ routines });
  } catch (error) {
    return fail(error);
  }
}

/** POST { name, prompt, cron: "0 8 * * 1", timezone?, continuity? } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const input = routineInput.parse(await request.json());
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE);
    const routine = await createRoutine(sql, { ...input, agencyId: xodo.agency_id, xodoId, createdBy: userId });
    return NextResponse.json({ routine }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** PATCH ?routine_id=…  { active }  liga ou desliga a rotina (ao religar, a próxima execução é recalculada). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const routineId = uuid.parse(new URL(request.url).searchParams.get("routine_id"));
    const { active } = z.object({ active: z.boolean() }).parse(await request.json());
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE);
    const row = await one<{ cron: string; timezone: string }>(sql, `select cron, timezone from xodo_routines where id = $1 and xodo_id = $2`, [routineId, xodoId]);
    if (!row) throw new XodoError("Rotina não encontrada", 404);
    const next = active ? nextRunAt(row.cron, row.timezone, new Date()) : null;
    await sql.query(`update xodo_routines set active = $2, next_run_at = coalesce($3::timestamptz, next_run_at) where id = $1`, [routineId, active, next?.toISOString() ?? null]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

/** DELETE ?routine_id=…  apaga a rotina. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const routineId = uuid.parse(new URL(request.url).searchParams.get("routine_id"));
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_MANAGE);
    const row = await one(sql, `delete from xodo_routines where id = $1 and xodo_id = $2 returning id`, [routineId, xodoId]);
    if (!row) throw new XodoError("Rotina não encontrada", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
