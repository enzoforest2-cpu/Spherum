import { categoryOf, quiet, type Cat } from "../core/push";
import { access } from "../integrations/store";
import { one, parseJson } from "../xodos/db";
import { integrationDepsOf, type Adapters, type ChannelDeps } from "./types";

/**
 * Avisos do sino também no Telegram e no WhatsApp: cada pessoa que ligou o celular (pareamento) e
 * deixou a opção ligada em "App de celular" recebe os avisos das mesmas categorias do push, fora do
 * horário de silêncio. A mensagem vai pela conversa que a pessoa já tem com os xodós naquele canal
 * (é o endereço que sabemos usar); quem nunca falou com um xodó por lá não recebe.
 */

type Target = { user_id: string; provider: string; connection_id: string; metadata: unknown; categories: Cat[] | null; quiet_start: number | null; quiet_end: number | null };

export async function forwardSweep(deps: ChannelDeps, adapters: Adapters, now = new Date(), opts: { deadline?: number } = {}) {
  const sql = deps.sql;
  const rows = await sql.query<{ id: number; agency_id: string; user_id: string | null; kind: string; title: string; body: string }>(
    `select id, agency_id, user_id, kind, title, body from notifications
      where forwarded_at is null and created_at > $1::timestamptz - interval '2 days' order by id limit 300`,
    [now.toISOString()],
  );
  const out = { sent: 0, skipped: 0, quiet: 0, failed: 0 };
  const integrations = integrationDepsOf(deps);
  for (const n of rows) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    // Marca antes de mandar: duas varreduras juntas não repetem o aviso.
    if (!(await one(sql, `update notifications set forwarded_at = $2 where id = $1 and forwarded_at is null returning id`, [n.id, now.toISOString()]))) continue;
    const cat = categoryOf(n.kind);
    if (!cat) { out.skipped++; continue; }
    // Uma conversa por pessoa e canal: a mais recente, numa conexão ativa.
    const targets = await sql.query<Target>(
      `select distinct on (i.user_id, i.provider) i.user_id, i.provider, c.connection_id, c.metadata, p.categories, p.quiet_start, p.quiet_end
         from channel_identities i
         join agency_members m on m.agency_id = i.agency_id and m.user_id = i.user_id
         left join push_prefs p on p.agency_id = i.agency_id and p.user_id = i.user_id
         join xodo_conversations c on c.agency_id = i.agency_id and c.channel = i.provider and c.external_key = i.external_user
         join integration_connections ic on ic.id = c.connection_id and ic.status = 'active'
        where i.agency_id = $1 and i.provider in ('telegram', 'whatsapp') and ($2::uuid is null or i.user_id = $2)
          and coalesce(p.channels, true)
        order by i.user_id, i.provider, c.last_message_at desc`,
      [n.agency_id, n.user_id],
    );
    if (!targets.length) { out.skipped++; continue; }
    for (const t of targets) {
      if (!(t.categories ?? ["appr", "hot", "fail", "chat"]).includes(cat)) continue;
      if (quiet(t.categories ? t.quiet_start : 22, t.categories ? t.quiet_end : 7, now)) { out.quiet++; continue; }
      const conn = await one<{ provider: string }>(sql, `select provider from integration_connections where id = $1`, [t.connection_id]);
      const adapter = conn ? adapters[conn.provider as keyof Adapters] : undefined;
      if (!adapter) continue;
      const text = `Aviso do Spherum: ${n.title}${n.body ? `\n${n.body}` : ""}`.slice(0, adapter.maxChars);
      try {
        const a = await access(integrations, n.agency_id, t.connection_id);
        await adapter.send({ deps: integrations, access: a, target: parseJson<Record<string, unknown>>(t.metadata) ?? {}, xodoName: null }, { text, approvals: [] });
        out.sent++;
      } catch (error) {
        // WhatsApp oficial fora da janela de 24 h, sessão do QR caída: o aviso continua no app.
        out.failed++;
        console.warn("[canais] aviso não repassado", t.provider, error instanceof Error ? error.message : error);
      }
    }
  }
  return out;
}
