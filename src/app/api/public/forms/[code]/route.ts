import { NextResponse } from "next/server";
import { publicForm, submitForm } from "@/lib/core/forms";
import { clientIp, leadSalt } from "@/lib/core/http";
import { serverSql } from "@/lib/xodos/db";
import { fail } from "@/lib/xodos/http";

type Ctx = { params: Promise<{ code: string }> };

/** GET /api/public/forms/:code  o formulário (sem login); conta a visita. */
export async function GET(_request: Request, { params }: Ctx) {
  try {
    return NextResponse.json(await publicForm(await serverSql(), (await params).code));
  } catch (error) {
    return fail(error);
  }
}

/** POST /api/public/forms/:code  { [campo]: valor }  a resposta vira negócio no CRM. Erros por campo vêm em fields. */
export async function POST(request: Request, { params }: Ctx) {
  try {
    return NextResponse.json(await submitForm(await serverSql(), (await params).code, await request.json(), clientIp(request), leadSalt()), { status: 201 });
  } catch (error) {
    const fields = (error as { fields?: Record<string, string> }).fields;
    if (fields) return NextResponse.json({ error: (error as Error).message, fields }, { status: 400 });
    return fail(error);
  }
}
