import { NextResponse } from "next/server";
import { mailerFromEnv } from "@/lib/core/email";
import { clientIp, leadSalt, requireAdmin } from "@/lib/core/http";
import { createLead, listLeads } from "@/lib/core/leads";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

/**
 * POST /api/leads  (público)  { kind, name, email, phone, company, message, scheduled_for, details }
 * Grava o contato ou a demonstração e avisa o comercial por e-mail (LEADS_NOTIFY_EMAIL).
 */
export async function POST(request: Request) {
  try {
    const sql = await serverSql();
    const lead = await createLead(
      { sql, mail: mailerFromEnv(), notifyTo: process.env.LEADS_NOTIFY_EMAIL?.trim() || undefined, salt: leadSalt() },
      await request.json(),
      clientIp(request),
    );
    return NextResponse.json({ protocol: lead.protocol }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

/** GET /api/leads?kind=&open=1  (equipe do Spherum) */
export async function GET(request: Request) {
  try {
    const { sql } = await requireAdmin(request);
    const url = new URL(request.url);
    return NextResponse.json({
      leads: await listLeads(sql, { kind: url.searchParams.get("kind") ?? undefined, open: url.searchParams.get("open") === "1" }),
    });
  } catch (error) {
    return fail(error);
  }
}
