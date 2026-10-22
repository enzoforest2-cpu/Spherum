import { NextResponse } from "next/server";
import { webPushSender } from "@/lib/core/push-web";
import { serverSql } from "@/lib/xodos/db";
import { XodoError } from "@/lib/xodos/errors";
import { CAN_READ, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/app/test  { agency_id }  manda uma notificação de teste para os seus aparelhos. */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const { agency_id } = await request.json();
    const agencyId = uuid.parse(agency_id);
    const sql = await serverSql();
    await requireRole(sql, userId, agencyId, CAN_READ);
    const send = webPushSender();
    if (!send) throw new XodoError("As notificações ainda não foram configuradas no servidor (chaves VAPID).", 503);
    const devices = await sql.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(`select id, endpoint, p256dh, auth from push_devices where agency_id = $1 and user_id = $2`, [agencyId, userId]);
    if (!devices.length) throw new XodoError("Ative as notificações neste aparelho primeiro.", 400);
    let ok = 0;
    for (const d of devices) {
      const r = await send(d, { title: "Spherum", body: "Tudo certo: as notificações estão chegando.", url: "/prototipo/agencia.html", tag: "teste" }).catch(() => "erro");
      if (r === "gone") await sql.query(`delete from push_devices where id = $1`, [d.id]); else if (r === "ok") ok++;
    }
    return NextResponse.json({ sent: ok, devices: devices.length });
  } catch (error) {
    return fail(error);
  }
}
