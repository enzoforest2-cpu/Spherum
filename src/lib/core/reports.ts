import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { audit } from "./audit";
import { recordReportUpdate } from "./collab";

/** Relatórios feitos pela equipe na tela (os xodós também criam, pelas ferramentas deles). */

export const reportInput = z.object({
  client_id: z.uuid(),
  title: z.string().trim().min(1).max(160),
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  body_md: z.string().max(60_000).default(""),
  publish: z.boolean().default(false),
});

export async function createReport(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const input = reportInput.parse(raw);
  if (input.period_end < input.period_start) throw new XodoError("O fim do período vem depois do início.", 400);
  const client = await one(sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [input.client_id, agencyId]);
  if (!client) throw new XodoError("Cliente não encontrado.", 404);
  const row = await one<{ id: string; status: string }>(
    sql,
    `insert into reports (agency_id, client_id, period_start, period_end, title, body_md, status, published_at, created_by_user)
     values ($1, $2, $3, $4, $5, $6, $7, case when $7 = 'published' then now() end, $8) returning id, status`,
    [agencyId, input.client_id, input.period_start, input.period_end, input.title, input.body_md, input.publish ? "published" : "draft", userId],
  );
  await audit(sql, { agencyId, actor: userId, action: input.publish ? "relatorio_publicado" : "relatorio_criado", targetType: "report", targetId: row!.id });
  if (input.publish) await recordReportUpdate(sql, row!.id);
  return row!;
}

export async function setReportStatus(sql: Sql, agencyId: string, userId: string, id: string, status: "published" | "draft" | "archived") {
  const row = await one(
    sql,
    `update reports set status = $3, published_at = case when $3 = 'published' then coalesce(published_at, now()) else published_at end
      where id = $1 and agency_id = $2 returning id`,
    [id, agencyId, status],
  );
  if (!row) throw new XodoError("Relatório não encontrado.", 404);
  if (status === "published") await recordReportUpdate(sql, id);
  await audit(sql, { agencyId, actor: userId, action: `relatorio_${status}`, targetType: "report", targetId: id });
}
