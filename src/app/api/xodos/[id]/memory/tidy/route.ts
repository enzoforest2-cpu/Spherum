import { NextResponse } from "next/server";
import { productionDeps } from "@/lib/xodos";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { runTidy } from "@/lib/xodos/memory/upkeep";
import { loadXodo } from "@/lib/xodos/runner";

// A arrumação faz até 3 chamadas ao modelo de rotinas.
export const maxDuration = 300;

/** POST /api/xodos/:id/memory/tidy  arruma a memória agora (no máximo uma vez por hora; conta no teto do dia). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const deps = await productionDeps();
    const xodo = await loadXodo(deps.sql, xodoId);
    await requireRole(deps.sql, userId, xodo.agency_id, CAN_MANAGE, { area: "xodos" });
    return NextResponse.json({ relatorio: await runTidy(deps, xodo, { manual: true }) });
  } catch (error) {
    return fail(error);
  }
}
