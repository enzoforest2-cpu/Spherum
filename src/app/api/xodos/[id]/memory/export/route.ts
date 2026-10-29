import { NextResponse } from "next/server";
import { serverSql } from "@/lib/xodos/db";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";
import { exportMarkdown } from "@/lib/xodos/memory/team";
import { loadXodo } from "@/lib/xodos/runner";

/** GET /api/xodos/:id/memory/export  notas ativas em markdown ("- AAAA-MM-DD · origem · texto · até AAAA-MM-DD"). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUser(request);
    const xodoId = uuid.parse((await params).id);
    const sql = await serverSql();
    const xodo = await loadXodo(sql, xodoId);
    await requireRole(sql, userId, xodo.agency_id, CAN_READ, { area: "xodos" });
    const { filename, markdown } = await exportMarkdown(sql, xodo);
    return new NextResponse(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return fail(error);
  }
}
