import { NextResponse } from "next/server";
import { audit } from "@/lib/core/audit";
import { staffCan } from "@/lib/core/admin";
import { requireStaff } from "@/lib/core/http";
import { setFlags, setPrices } from "@/lib/core/platform";
import { serverSql } from "@/lib/xodos/db";
import { fail, requireUser } from "@/lib/xodos/http";

/** PATCH /api/admin/settings  { flags?: { xodo?, studio?, prospect?, signup?, maint? }, prices?: { solo, agencia, escala, rede, empresarial } }  (dono) */
export async function PATCH(request: Request) {
  try {
    const userId = await requireUser(request);
    const sql = await serverSql();
    staffCan(await requireStaff(sql, userId), "settings");
    const body = await request.json();
    const out: Record<string, unknown> = {};
    if (body.flags) {
      out.flags = await setFlags(sql, userId, body.flags);
      await audit(sql, { agencyId: null, actor: userId, action: "admin_config", targetType: "flags", summary: `Recursos: ${Object.entries(body.flags).map(([k, v]) => `${k} ${v ? "ligado" : "desligado"}`).join(", ")}`.slice(0, 300) });
    }
    if (body.prices) {
      out.prices = await setPrices(sql, userId, body.prices);
      await audit(sql, { agencyId: null, actor: userId, action: "admin_config", targetType: "prices", summary: "Preços dos planos atualizados" });
    }
    return NextResponse.json(out);
  } catch (error) {
    return fail(error);
  }
}
