import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/core/http";
import { bookedSlots, demoCalendarInput, getSetting, setSetting } from "@/lib/core/leads";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser } from "@/lib/xodos/http";

/** GET /api/site/demo  (público)  agenda de demonstrações e horários já reservados (sem dados de ninguém). */
export async function GET() {
  try {
    const sql = await serverSql();
    const [calendar, booked] = await Promise.all([getSetting(sql, "demo_calendar"), bookedSlots(sql, new Date())]);
    return NextResponse.json({ calendar, booked }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fail(error);
  }
}

/** PUT /api/site/demo  { dur, buffer, days, from, to, lunch, notice, ahead, video?, owner? }  (equipe do Spherum) */
export async function PUT(request: Request) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    await requireStaff(sql, userId);
    const calendar = demoCalendarInput.parse(await request.json());
    await setSetting(sql, "demo_calendar", calendar, userId);
    return NextResponse.json({ calendar });
  } catch (error) {
    return fail(error);
  }
}
