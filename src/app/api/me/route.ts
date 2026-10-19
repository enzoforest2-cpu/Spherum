import { NextResponse } from "next/server";
import { me, updateProfile } from "@/lib/core/agencies";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireAuth } from "@/lib/xodos/http";

/** GET /api/me  perfil, agências (com papel), portais de cliente e para onde ir depois do login. */
export async function GET(request: Request) {
  try {
    const user = await requireAuth(request);
    return NextResponse.json(await me(await serverSql(), user));
  } catch (error) {
    return fail(error);
  }
}

/** PATCH /api/me  { full_name?, phone? } */
export async function PATCH(request: Request) {
  try {
    const user = await requireAuth(request);
    const sql = await serverSql();
    await updateProfile(sql, user.id, await request.json());
    return NextResponse.json(await me(sql, user));
  } catch (error) {
    return fail(error);
  }
}
