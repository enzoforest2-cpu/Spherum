import { after, NextResponse } from "next/server";
import { z } from "zod";
import { computerDeps } from "@/lib/computer";
import { takeoverDoneByMessage, withEngine } from "@/lib/computer/control";
import { one, serverSql } from "@/lib/xodos/db";
import { CAN_READ, CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { continueRun, productionDeps, startRun } from "@/lib/xodos";
import { loadXodo } from "@/lib/xodos/runner";

// Uma execução pode levar alguns minutos (até 12 passos com o modelo).
export const maxDuration = 300;

/** GET /api/xodos/:id/messages  conversa recente, pedidos pendentes e a última execução. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_READ);
    const [messages, pending, runs] = await Promise.all([
      sql.query(
        `select * from (select id, run_id, role, author_user, text, created_at::text from xodo_messages
           where xodo_id = $1 and agency_id = $2 and conversation_id is null order by id desc limit 50) m order by id`,
        [xodoId, xodo.agency_id],
      ),
      sql.query(
        `select id, run_id, tool_name, category, input, reason, expires_at::text, created_at::text from xodo_actions
          where xodo_id = $1 and agency_id = $2 and status = 'pending' order by created_at`,
        [xodoId, xodo.agency_id],
      ),
      sql.query(
        `select id, status, steps, error, started_at::text, finished_at::text from xodo_runs
          where xodo_id = $1 and agency_id = $2 order by started_at desc limit 1`,
        [xodoId, xodo.agency_id],
      ),
    ]);
    return NextResponse.json({ messages, pending_actions: pending, last_run: runs[0] ?? null });
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/xodos/:id/messages  { text }  responde 202 na hora; o xodó trabalha em segundo plano. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(await request.json());
    const deps = await productionDeps();
    const xodo = await loadXodo(deps.sql, xodoId);
    await requireRole(deps.sql, userId, xodo.agency_id, CAN_USE);
    // O xodó esperava a pessoa no computador: a mensagem vale como "terminei" e vai junto.
    const waiting = await one<{ id: string }>(
      deps.sql,
      `select id from xodo_runs where xodo_id = $1 and status = 'waiting_takeover' and conversation_id is null
        order by started_at desc limit 1`,
      [xodoId],
    );
    if (waiting) {
      const machines = withEngine(computerDeps(deps.sql), deps, (runId, task) =>
        after(() => task().catch((error) => console.error("[xodos] retomada falhou", runId, error))),
      );
      if (await takeoverDoneByMessage(machines, waiting.id, userId, text)) {
        return NextResponse.json({ run_id: waiting.id }, { status: 202 });
      }
    }
    const runId = await startRun(deps, { xodoId, agencyId: xodo.agency_id, trigger: "user", text, userId });
    after(() => continueRun(deps, runId).catch((error) => console.error("[xodos] execução falhou", runId, error)));
    return NextResponse.json({ run_id: runId }, { status: 202 });
  } catch (error) {
    return fail(error);
  }
}
