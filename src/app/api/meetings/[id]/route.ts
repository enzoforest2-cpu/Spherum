import { NextResponse } from "next/server";
import { z } from "zod";
import { mailerFromEnv } from "@/lib/core/email";
import { meetingAgency } from "@/lib/core/http";
import { deleteMeeting, sendMinutes, stepsToTasks, toggleStep, writeMinutes } from "@/lib/core/meetings";
import { one, serverSql } from "@/lib/xodos/db";
import { CAN_USE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ id: string }> };

const body = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("ata"), summary: z.string(), decisions: z.array(z.string()).optional(), steps: z.array(z.unknown()).optional(), attendees: z.array(z.string()).optional() }),
  z.object({ acao: z.literal("passo"), step_id: uuid, done: z.boolean() }),
  z.object({ acao: z.literal("tarefas") }),
  z.object({ acao: z.literal("enviar"), emails: z.array(z.email().trim().toLowerCase()).max(20).default([]) }),
]);

async function access(request: Request, params: Ctx["params"]) {
  const userId = await requireUser(request);
  const id = uuid.parse((await params).id);
  const sql = await serverSql();
  const agencyId = await meetingAgency(sql, id);
  await requireRole(sql, userId, agencyId, CAN_USE, { area: "projetos" });
  return { userId, id, agencyId, sql };
}

/**
 * PATCH /api/meetings/:id  { acao, ... }
 *   ata { summary, decisions?, steps?: [{ title, owner?, due_date? }], attendees? }   passo { step_id, done }
 *   tarefas  (passos da equipe viram tarefas em Projetos)   enviar { emails? }  (portal + e-mail)
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    const p = body.parse(await request.json());
    if (p.acao === "ata") {
      const { acao: _a, ...rest } = p;
      void _a;
      return NextResponse.json(await writeMinutes(sql, agencyId, { userId }, id, rest));
    }
    if (p.acao === "passo") {
      await toggleStep(sql, agencyId, id, p.step_id, p.done);
      return NextResponse.json({ ok: true });
    }
    if (p.acao === "tarefas") return NextResponse.json(await stepsToTasks(sql, agencyId, userId, id));
    const m = await sendMinutes(sql, agencyId, userId, id);
    let emailed = 0;
    if (p.emails.length) {
      const agency = await one<{ name: string }>(sql, `select name from agencies where id = $1`, [agencyId]);
      const text = [`Ata da reunião "${m.title}"`, "", m.summary ?? "", ...(m.decisions.length ? ["", "Decisões:", ...m.decisions.map((d) => `- ${d}`)] : [])].join("\n");
      const ok = await mailerFromEnv()({ to: p.emails, subject: `${agency?.name ?? "Agência"}: ata de ${m.title}`.slice(0, 200), text }).catch(() => false);
      emailed = ok ? p.emails.length : 0;
    }
    return NextResponse.json({ ok: true, emailed });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const { userId, id, agencyId, sql } = await access(request, params);
    await deleteMeeting(sql, agencyId, userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
