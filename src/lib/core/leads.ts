import { createHash } from "node:crypto";
import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import type { Mailer } from "./email";

/**
 * O que chega pelo site público: contato, pedido de demonstração (com horário), cadastro e
 * quiz. Tudo fica gravado e a equipe comercial recebe um e-mail; o visitante nunca vê erro de
 * envio de e-mail (o pedido já está salvo).
 */

const MAX_PER_HOUR = 8;

export const leadInput = z.object({
  kind: z.enum(["contato", "demonstracao", "cadastro", "quiz", "lista_espera"]),
  name: z.string().trim().max(120).optional(),
  email: z.email().trim().toLowerCase().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(120).optional(),
  message: z.string().max(4000).optional(),
  scheduled_for: z.iso.datetime({ offset: true }).optional(),
  // O resto do formulário (motivo, cargo, nº de clientes, ferramentas, canal preferido…).
  details: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(80)).max(20)])).optional(),
});

export type LeadDeps = { sql: Sql; mail?: Mailer; notifyTo?: string; salt: string; now?: () => Date };

export function ipHash(ip: string | null, salt: string): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/** Número de protocolo mostrado ao visitante (SPH-AAAA-NNNNN), derivado do id. */
export function protocolOf(id: string, at: Date): string {
  const n = parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % 100000;
  return `SPH-${at.getUTCFullYear()}-${String(n).padStart(5, "0")}`;
}

export async function createLead(deps: LeadDeps, raw: unknown, ip: string | null) {
  const input = leadInput.parse(raw);
  const now = deps.now ? deps.now() : new Date();
  if (!input.email && !input.phone) throw new XodoError("Informe um e-mail ou telefone para a gente responder.", 400);
  const hash = ipHash(ip, deps.salt);
  if (hash) {
    const recent = await one<{ n: number }>(
      deps.sql,
      `select count(*)::int as n from site_leads where ip_hash = $1 and created_at > $2::timestamptz`,
      [hash, new Date(now.getTime() - 3_600_000).toISOString()],
    );
    if ((recent?.n ?? 0) >= MAX_PER_HOUR) throw new XodoError("Muitos envios seguidos. Tente de novo daqui a pouco.", 429);
  }
  let scheduled: Date | null = null;
  if (input.kind === "demonstracao" && input.scheduled_for) {
    scheduled = new Date(input.scheduled_for);
    if (scheduled.getTime() < now.getTime() + 30 * 60_000 || scheduled.getTime() > now.getTime() + 90 * 86_400_000) {
      throw new XodoError("Esse horário não está disponível. Escolha outro.", 409);
    }
  }
  let row: { id: string } | null;
  try {
    row = await one<{ id: string }>(
      deps.sql,
      `insert into site_leads (kind, name, email, phone, company, message, scheduled_for, payload, ip_hash, created_at)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb, $9, $10::timestamptz) returning id`,
      [input.kind, input.name ?? null, input.email ?? null, input.phone ?? null, input.company ?? null, input.message ?? null,
        scheduled?.toISOString() ?? null, json(input.details ?? {}), hash, now.toISOString()],
    );
  } catch (error) {
    // Índice único do horário: outra pessoa pegou o mesmo horário agora.
    if (String((error as { code?: string }).code) === "23505") throw new XodoError("Esse horário acabou de ser reservado. Escolha outro.", 409);
    throw error;
  }
  const protocol = protocolOf(row!.id, now);
  if (deps.mail && deps.notifyTo) {
    const when = scheduled ? scheduled.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "short" }) : null;
    const lines = [
      `Novo ${input.kind === "demonstracao" ? "pedido de demonstração" : input.kind} pelo site (${protocol}).`,
      "",
      `Nome: ${input.name ?? "-"}`,
      `E-mail: ${input.email ?? "-"}`,
      `Telefone: ${input.phone ?? "-"}`,
      `Empresa: ${input.company ?? "-"}`,
      when ? `Horário: ${when}` : null,
      input.message ? `\nMensagem:\n${input.message}` : null,
      input.details ? `\nDetalhes:\n${Object.entries(input.details).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n")}` : null,
    ].filter((l) => l !== null);
    await deps.mail({ to: deps.notifyTo, subject: `[Site] ${input.name ?? input.email ?? "Novo contato"} · ${protocol}`, text: lines.join("\n"), replyTo: input.email });
  }
  return { id: row!.id, protocol };
}

/** Horários de demonstração já reservados (sem dados de ninguém), para o site marcar como ocupados. */
export async function bookedSlots(sql: Sql, from: Date, days = 60) {
  const rows = await sql.query<{ at: string }>(
    `select to_char(scheduled_for at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at from site_leads
      where kind = 'demonstracao' and handled_at is null and scheduled_for >= $1::timestamptz and scheduled_for < $2::timestamptz
      order by scheduled_for`,
    [from.toISOString(), new Date(from.getTime() + days * 86_400_000).toISOString()],
  );
  return rows.map((r) => r.at);
}

// ---------------------------------------------------------------------------
// Para a equipe do Spherum (portal admin)
// ---------------------------------------------------------------------------

export async function listLeads(sql: Sql, opts: { kind?: string; open?: boolean; limit?: number } = {}) {
  return sql.query(
    `select id, kind, name, email, phone, company, message, scheduled_for::text, payload, handled_at::text, created_at::text
       from site_leads
      where ($1::text is null or kind = $1) and (not $2 or handled_at is null)
      order by created_at desc limit $3`,
    [opts.kind ?? null, opts.open ?? false, Math.min(opts.limit ?? 100, 500)],
  );
}

export async function markLeadHandled(sql: Sql, id: string, handled: boolean) {
  const row = await one(sql, `update site_leads set handled_at = case when $2 then now() else null end where id = $1 returning id`, [id, handled]);
  if (!row) throw new XodoError("Não encontrado", 404);
}

/** Configuração da agenda de demonstrações (a mesma do design: dias, horários, duração…). */
export const demoCalendarInput = z
  .object({
    connected: z.boolean().default(true),
    dur: z.number().int().min(15).max(120),
    buffer: z.number().int().min(0).max(60),
    days: z.array(z.number().int().min(0).max(6)).max(7),
    // Horas cheias, como no design (9 = 9h).
    from: z.number().int().min(0).max(23),
    to: z.number().int().min(1).max(24),
    lunch: z.boolean(),
    notice: z.number().int().min(0).max(168),
    ahead: z.number().int().min(1).max(30),
    video: z.string().max(40).optional(),
    owner: z.string().max(120).optional(),
    email: z.email().max(254).optional(),
    provider: z.string().max(40).optional(),
  })
  .refine((c) => c.to > c.from, { message: "O fim do expediente precisa vir depois do início" });

export async function getSetting<T>(sql: Sql, key: string): Promise<T | null> {
  const row = await one<{ value: T }>(sql, `select value from site_settings where key = $1`, [key]);
  return row?.value ?? null;
}

export async function setSetting(sql: Sql, key: string, value: unknown, userId: string) {
  await sql.query(
    `insert into site_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, json(value), userId],
  );
}
