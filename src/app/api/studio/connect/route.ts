import { NextResponse } from "next/server";
import { z } from "zod";
import { setConfig } from "@/lib/core/studio";
import { connectStudio } from "@/lib/core/studio-providers";
import { serverIntegrations } from "@/lib/integrations";
import { serverSql } from "@/lib/xodos/db";
import { CAN_MANAGE, fail, requireRole, requireUser, uuid } from "@/lib/xodos/http";

/** POST /api/studio/connect  { agency_id, provider: fal | replicate, key, image_model?, video_model? }  (dono ou admin). */
export async function POST(request: Request) {
  try {
    const userId = await requireUser(request);
    const p = z.object({ agency_id: uuid, provider: z.enum(["fal", "replicate"]), key: z.string(), image_model: z.string().optional(), video_model: z.string().nullable().optional() }).parse(await request.json());
    const sql = await serverSql();
    await requireRole(sql, userId, p.agency_id, CAN_MANAGE, { area: "projetos" });
    const id = await connectStudio({ sql, ...serverIntegrations() }, p.agency_id, userId, p.provider, p.key);
    await setConfig(sql, p.agency_id, { provider: p.provider, connection_id: id, image_model: p.image_model, video_model: p.video_model });
    return NextResponse.json({ connection_id: id }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
