import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { createDeal } from "./crm";
import type { Mailer } from "./email";

/**
 * Agendamentos: cada tipo de reunião tem uma página pública (/agenda/<código>) com os horários
 * livres nos dias e horas escolhidos, no fuso de Brasília, de 30 em 30 minutos. Fica de fora o que
 * já está marcado com a mesma pessoa e, com a Google Agenda conectada, o que está ocupado nela.
 * Ao agendar: evento com Meet na agenda, e-mail com o link de cancelamento e, para quem ainda não
 * é cliente, um negócio no CRM.
 */

const OFFSET = "-03:00"; // Brasília, sem horário de verão desde 2019
const TZ = "America/Sao_Paulo";
const STEP_MIN = 30;

export type BookingCalendar = {
  busy(from: Date, to: Date): Promise<{ start: Date; end: Date }[]>;
  create(ev: { summary: string; description: string; start: Date; end: Date; attendee: string }): Promise<{ id: string; meet: string | null }>;
  cancel(eventId: string): Promise<void>;
};
export type CalendarFor = (agencyId: string, connectionId: string, calendarId: string) => BookingCalendar;
export type BookingDeps = { sql: Sql; calendarFor: CalendarFor; mailer: Mailer; appUrl: string };

const code = () => randomBytes(8).toString("hex").slice(0, 10);
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export const dayOf = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const at = (day: string, min: number) => new Date(`${day}T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00${OFFSET}`);
const addDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dow = (day: string) => new Date(`${day}T12:00:00${OFFSET}`).getUTCDay();
export const hhmm = (d: Date) => d.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const longDate = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });

export const typeInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  duration_min: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60), z.literal(90)]).default(30),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#465FFF"),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
  from_hour: z.number().int().min(0).max(23).default(9),
  to_hour: z.number().int().min(1).max(24).default(18),
  min_notice_hours: z.number().int().min(0).max(168).default(2),
  max_days_ahead: z.number().int().min(1).max(90).default(30),
  connection_id: z.uuid().nullable().optional(),
  calendar_id: z.string().trim().min(1).max(200).default("primary"),
  owner_user: z.uuid().nullable().optional(),
  create_deal: z.boolean().default(true),
  active: z.boolean().default(true),
});
export const typePatch = typeInput.partial();

async function checkRefs(sql: Sql, agencyId: string, i: { connection_id?: string | null; owner_user?: string | null; from_hour?: number; to_hour?: number }) {
  if (i.from_hour !== undefined && i.to_hour !== undefined && i.to_hour <= i.from_hour) throw new XodoError("O fim do horário precisa ser depois do início.", 400);
  if (i.connection_id) {
    const c = await one<{ provider: string; scopes: string[] | null }>(sql, `select provider, scopes from integration_connections where id = $1 and agency_id = $2 and status <> 'revoked'`, [i.connection_id, agencyId]);
    if (!c || c.provider !== "google") throw new XodoError("Escolha uma conexão Google com a Agenda.", 400);
  }
  if (i.owner_user && !(await one(sql, `select 1 from agency_members where agency_id = $1 and user_id = $2`, [agencyId, i.owner_user]))) throw new XodoError("Essa pessoa não é da equipe.", 400);
}

export async function createType(sql: Sql, agencyId: string, userId: string, raw: unknown) {
  const i = typeInput.parse(raw);
  await checkRefs(sql, agencyId, i);
  return (await one<{ id: string; code: string }>(
    sql,
    `insert into booking_types (agency_id, code, name, description, duration_min, color, days, from_hour, to_hour, min_notice_hours, max_days_ahead, connection_id, calendar_id, owner_user, create_deal, active, created_by)
     values ($1, $2, $3, $4, $5, $6, $7::int[], $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id, code`,
    [agencyId, code(), i.name, i.description ?? null, i.duration_min, i.color, [...new Set(i.days)], i.from_hour, i.to_hour, i.min_notice_hours, i.max_days_ahead,
      i.connection_id ?? null, i.calendar_id, i.owner_user === undefined ? userId : i.owner_user, i.create_deal, i.active, userId],
  ))!;
}

type TypeRow = { id: string; agency_id: string; code: string; name: string; description: string | null; duration_min: number; color: string; days: number[]; from_hour: number; to_hour: number; min_notice_hours: number; max_days_ahead: number; connection_id: string | null; calendar_id: string; owner_user: string | null; create_deal: boolean; active: boolean };
const TYPE_COLS = `id, agency_id, code, name, description, duration_min, color, days, from_hour, to_hour, min_notice_hours, max_days_ahead, connection_id, calendar_id, owner_user, create_deal, active`;

async function typeOf(sql: Sql, agencyId: string, id: string) {
  const t = await one<TypeRow>(sql, `select ${TYPE_COLS} from booking_types where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!t) throw new XodoError("Tipo de reunião não encontrado.", 404);
  return t;
}

export async function updateType(sql: Sql, agencyId: string, id: string, raw: unknown) {
  const i = typePatch.parse(raw);
  const cur = await typeOf(sql, agencyId, id);
  await checkRefs(sql, agencyId, { ...i, from_hour: i.from_hour ?? cur.from_hour, to_hour: i.to_hour ?? cur.to_hour });
  const sets: string[] = [], vals: unknown[] = [id];
  for (const [k, v] of Object.entries(i)) {
    if (v === undefined) continue;
    vals.push(k === "days" ? [...new Set(v as number[])] : v);
    sets.push(`${k} = $${vals.length}${k === "days" ? "::int[]" : ""}`);
  }
  if (sets.length) await sql.query(`update booking_types set ${sets.join(", ")} where id = $1`, vals);
}

export async function deleteType(sql: Sql, agencyId: string, id: string) {
  await typeOf(sql, agencyId, id);
  const future = await one<{ n: number }>(sql, `select count(*)::int as n from bookings where type_id = $1 and status = 'confirmada' and start_at > now()`, [id]);
  if (future!.n) throw new XodoError(`Esse tipo tem ${future!.n} reunião(ões) marcada(s). Cancele antes ou desative o tipo.`, 409);
  await sql.query(`delete from booking_types where id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Horários
// ---------------------------------------------------------------------------

/** Reuniões já marcadas que ocupam a mesma pessoa (mesmo responsável) ou o mesmo tipo. */
async function takenFor(sql: Sql, t: TypeRow, from: Date, to: Date) {
  const rows = await sql.query<{ start_at: string; end_at: string }>(
    `select b.start_at::text, b.end_at::text from bookings b join booking_types bt on bt.id = b.type_id
      where b.agency_id = $1 and b.status = 'confirmada' and b.start_at < $4 and b.end_at > $3
        and (b.type_id = $2 or (bt.owner_user is not distinct from $5::uuid and $5::uuid is not null))`,
    [t.agency_id, t.id, from.toISOString(), to.toISOString(), t.owner_user],
  );
  return rows.map((r) => ({ start: new Date(r.start_at), end: new Date(r.end_at) }));
}

/** Horários livres por dia (de hoje até o limite de dias), já sem os ocupados. */
export async function availableSlots(deps: Pick<BookingDeps, "sql" | "calendarFor">, t: TypeRow, now: Date, opts: { fromDay?: string; days?: number } = {}) {
  const first = opts.fromDay && opts.fromDay > dayOf(now) ? opts.fromDay : dayOf(now);
  const last = addDay(dayOf(now), t.max_days_ahead);
  const candidates: { day: string; start: Date; end: Date }[] = [];
  for (let d = first, n = 0; d <= last && n < (opts.days ?? 999); d = addDay(d, 1), n++) {
    if (!t.days.includes(dow(d))) continue;
    for (let m = t.from_hour * 60; m + t.duration_min <= t.to_hour * 60; m += STEP_MIN) {
      const start = at(d, m);
      if (start.getTime() < now.getTime() + t.min_notice_hours * 3600_000) continue;
      candidates.push({ day: d, start, end: new Date(start.getTime() + t.duration_min * 60_000) });
    }
  }
  if (!candidates.length) return [];
  const from = candidates[0].start, to = candidates[candidates.length - 1].end;
  let busy = await takenFor(deps.sql, t, from, to);
  if (t.connection_id) busy = busy.concat(await deps.calendarFor(t.agency_id, t.connection_id, t.calendar_id).busy(from, to));
  const free = candidates.filter((c) => !busy.some((b) => b.start < c.end && b.end > c.start));
  const byDay = new Map<string, string[]>();
  for (const c of free) byDay.set(c.day, [...(byDay.get(c.day) ?? []), hhmm(c.start)]);
  return [...byDay].map(([day, slots]) => ({ day, slots }));
}

async function byCode(sql: Sql, typeCode: string) {
  if (!/^[a-z0-9]{8,16}$/.test(typeCode)) return null;
  return one<TypeRow & { agency_name: string; brand_color: string | null; owner_name: string | null }>(
    sql,
    `select ${TYPE_COLS.split(", ").map((c) => "t." + c).join(", ")}, a.name as agency_name, a.brand_color, coalesce(p.full_name, u.email) as owner_name
       from booking_types t join agencies a on a.id = t.agency_id left join profiles p on p.id = t.owner_user left join auth.users u on u.id = t.owner_user
      where t.code = $1`,
    [typeCode],
  );
}

/** A página pública: o tipo e os horários livres. */
export async function publicBooking(deps: Pick<BookingDeps, "sql" | "calendarFor">, typeCode: string, now = new Date()) {
  const t = await byCode(deps.sql, typeCode);
  if (!t || !t.active) throw new XodoError("Agenda não encontrada.", 404);
  let days: { day: string; slots: string[] }[] = [];
  let calendarOk = true;
  try {
    days = await availableSlots(deps, t, now);
  } catch (error) {
    // Agenda do Google fora do ar: sem ela não dá para garantir que o horário está livre.
    console.warn("[agenda] horários falharam", t.id, error instanceof Error ? error.message : error);
    calendarOk = false;
  }
  return { name: t.name, description: t.description, duration_min: t.duration_min, color: t.color, agency: t.agency_name, brand_color: t.brand_color, host: t.owner_name, meet: !!t.connection_id, days, available: calendarOk, timezone: "Horário de Brasília" };
}

// ---------------------------------------------------------------------------
// Agendar e cancelar
// ---------------------------------------------------------------------------

export const bookInput = z.object({
  start: z.iso.datetime({ offset: true }),
  name: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase().max(254),
  phone: z.string().trim().max(40).optional().or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(1000).optional(),
});

export async function book(deps: BookingDeps, typeCode: string, raw: unknown, ip: string | null, salt: string, now = new Date()) {
  const { sql } = deps;
  const t = await byCode(sql, typeCode);
  if (!t || !t.active) throw new XodoError("Agenda não encontrada.", 404);
  const input = bookInput.parse(raw);
  if (input.phone && input.phone.replace(/\D/g, "").length < 10) throw new XodoError("WhatsApp incompleto.", 400);
  const start = new Date(input.start), end = new Date(start.getTime() + t.duration_min * 60_000);
  const ipHash = ip ? hash(`${salt}:${ip}`) : null;
  if (ipHash) {
    const recent = await one<{ n: number }>(sql, `select count(*)::int as n from bookings where type_id = $1 and ip_hash = $2 and created_at > $3::timestamptz - interval '1 hour'`, [t.id, ipHash, now.toISOString()]);
    if ((recent?.n ?? 0) >= 5) throw new XodoError("Muitos agendamentos seguidos. Tente de novo mais tarde.", 429);
  }
  // O horário precisa estar entre os livres (agenda do Google incluída).
  const free = await availableSlots(deps, t, now, { fromDay: dayOf(start), days: 1 });
  if (!free.some((d) => d.day === dayOf(start) && d.slots.includes(hhmm(start)))) throw new XodoError("Esse horário não está mais livre. Escolha outro.", 409);
  const token = randomBytes(24).toString("base64url");
  const booking = await sql.transaction(async (tx) => {
    // Duas pessoas no mesmo horário ao mesmo tempo: só a primeira fica.
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`agenda:${t.owner_user ?? t.id}`]);
    const clash = await takenFor(tx, t, start, end);
    if (clash.length) throw new XodoError("Esse horário acabou de ser marcado. Escolha outro.", 409);
    return (await one<{ id: string }>(
      tx,
      `insert into bookings (agency_id, type_id, name, email, phone, notes, start_at, end_at, cancel_hash, ip_hash) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [t.agency_id, t.id, input.name, input.email, input.phone ?? null, input.notes ?? null, start.toISOString(), end.toISOString(), hash(token), ipHash],
    ))!;
  });

  let meet: string | null = null;
  if (t.connection_id) {
    try {
      const ev = await deps.calendarFor(t.agency_id, t.connection_id, t.calendar_id).create({
        summary: `${t.name} · ${input.name}`, start, end, attendee: input.email,
        description: [`Agendado pela página do Spherum.`, input.phone ? `WhatsApp: ${input.phone}` : "", input.notes ? `Observações: ${input.notes}` : ""].filter(Boolean).join("\n"),
      });
      meet = ev.meet;
      await sql.query(`update bookings set google_event_id = $2, meet_link = $3 where id = $1`, [booking.id, ev.id, ev.meet]);
    } catch (error) {
      await sql.query(`update bookings set calendar_error = $2 where id = $1`, [booking.id, (error instanceof Error ? error.message : String(error)).slice(0, 400)]);
    }
  }

  // Cliente já conhecido fica ligado ao cliente; quem é novo vira negócio no CRM.
  const client = await one<{ client_id: string }>(sql, `select client_id from client_contacts where agency_id = $1 and lower(email) = $2 limit 1`, [t.agency_id, input.email]);
  if (client) await sql.query(`update bookings set client_id = $2 where id = $1`, [booking.id, client.client_id]);
  else if (t.create_deal) {
    const open = await one<{ id: string }>(sql, `select id from deals where agency_id = $1 and lower(email) = $2 and stage not in ('ganho', 'perdido') limit 1`, [t.agency_id, input.email]);
    const actor = t.owner_user ?? (await one<{ user_id: string }>(sql, `select user_id from agency_members where agency_id = $1 and role = 'owner' limit 1`, [t.agency_id]))!.user_id;
    const nextAction = `${t.name} em ${dayOf(start).split("-").reverse().join("/")} às ${hhmm(start)}`.slice(0, 200);
    if (open) {
      await sql.query(`update deals set next_action = $2, next_action_date = $3 where id = $1`, [open.id, nextAction, dayOf(start)]);
      await sql.query(`update bookings set deal_id = $2 where id = $1`, [booking.id, open.id]);
    } else {
      const deal = await createDeal(sql, t.agency_id, actor, {
        company: input.name, contact_name: input.name, email: input.email, phone: input.phone ?? null, source: "Agendamento", stage: "diagnostico",
        owner_user: t.owner_user, next_action: nextAction, next_action_date: dayOf(start), notes: input.notes ? `Observações do agendamento: ${input.notes}` : null,
      });
      await sql.query(`update bookings set deal_id = $2 where id = $1`, [booking.id, deal.id]);
    }
  }
  await sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'reuniao_agendada', $2, jsonb_build_object('booking_id', $3::text))`,
    [t.agency_id, `${input.name} marcou ${t.name}: ${longDate(start)}, ${hhmm(start)}`.slice(0, 200), booking.id]);

  const cancelUrl = `${deps.appUrl}/agenda/cancelar/${token}`;
  await deps.mailer({
    to: input.email,
    subject: `Confirmado: ${t.name} com ${t.agency_name}`,
    text: [`Oi, ${input.name.split(" ")[0]}!`, "", `Sua reunião está marcada para ${longDate(start)}, às ${hhmm(start)} (horário de Brasília), com duração de ${t.duration_min} minutos.`,
      meet ? `Link da chamada: ${meet}` : "O link da chamada chega por aqui antes da reunião.", "", `Precisa cancelar? ${cancelUrl}`, "", t.agency_name].join("\n"),
  }).catch(() => false);
  return { id: booking.id, start: start.toISOString(), end: end.toISOString(), meet, cancel_token: token };
}

async function cancel(deps: BookingDeps, b: { id: string; agency_id: string; type_id: string; google_event_id: string | null; status: string }, by: "agencia" | "convidado") {
  if (b.status === "cancelada") return false;
  await deps.sql.query(`update bookings set status = 'cancelada', cancelled_by = $2 where id = $1`, [b.id, by]);
  if (b.google_event_id) {
    const t = await one<{ connection_id: string | null; calendar_id: string }>(deps.sql, `select connection_id, calendar_id from booking_types where id = $1`, [b.type_id]);
    if (t?.connection_id) await deps.calendarFor(b.agency_id, t.connection_id, t.calendar_id).cancel(b.google_event_id).catch((e) => console.warn("[agenda] evento não cancelado", b.id, e instanceof Error ? e.message : e));
  }
  return true;
}

const BOOKING_COLS = `b.id, b.agency_id, b.type_id, b.google_event_id, b.status, b.name, b.email, b.start_at::text, t.name as type_name, a.name as agency_name`;
type BookingRow = { id: string; agency_id: string; type_id: string; google_event_id: string | null; status: string; name: string; email: string; start_at: string; type_name: string; agency_name: string };

/** O convidado cancela pelo link do e-mail. */
export async function cancelByToken(deps: BookingDeps, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new XodoError("Link inválido.", 404);
  const b = await one<BookingRow>(deps.sql, `select ${BOOKING_COLS} from bookings b join booking_types t on t.id = b.type_id join agencies a on a.id = b.agency_id where b.cancel_hash = $1`, [hash(token)]);
  if (!b) throw new XodoError("Link inválido.", 404);
  const done = await cancel(deps, b, "convidado");
  if (done) {
    await deps.sql.query(`insert into notifications (agency_id, kind, title, data) values ($1, 'reuniao_cancelada', $2, jsonb_build_object('booking_id', $3::text))`,
      [b.agency_id, `${b.name} cancelou ${b.type_name} de ${longDate(new Date(b.start_at))}, ${hhmm(new Date(b.start_at))}`.slice(0, 200), b.id]);
  }
  return { cancelled: true, already: !done, type: b.type_name, agency: b.agency_name, start: b.start_at };
}

/** A agência cancela: o convidado recebe um e-mail. */
export async function cancelBooking(deps: BookingDeps, agencyId: string, id: string, reason?: string) {
  const b = await one<BookingRow>(deps.sql, `select ${BOOKING_COLS} from bookings b join booking_types t on t.id = b.type_id join agencies a on a.id = b.agency_id where b.id = $1 and b.agency_id = $2`, [id, agencyId]);
  if (!b) throw new XodoError("Reunião não encontrada.", 404);
  if (!(await cancel(deps, b, "agencia"))) throw new XodoError("Essa reunião já foi cancelada.", 409);
  const s = new Date(b.start_at);
  await deps.mailer({ to: b.email, subject: `Cancelada: ${b.type_name} com ${b.agency_name}`,
    text: [`Oi, ${b.name.split(" ")[0]}.`, "", `A reunião de ${longDate(s)}, às ${hhmm(s)}, foi cancelada pela ${b.agency_name}.`, reason ? `Motivo: ${reason}` : "", "", "Se quiser, marque outro horário pela mesma página."].filter((x) => x !== "").join("\n") }).catch(() => false);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export async function bookingBoard(sql: Sql, agencyId: string, now = new Date()) {
  const [types, bookings] = await Promise.all([
    sql.query<TypeRow & { upcoming: number }>(
      `select ${TYPE_COLS}, (select count(*)::int from bookings b where b.type_id = t.id and b.status = 'confirmada' and b.start_at > $2) as upcoming
         from booking_types t where agency_id = $1 order by created_at`,
      [agencyId, now.toISOString()],
    ),
    sql.query<{ id: string; type_id: string; name: string; email: string; phone: string | null; notes: string | null; start_at: string; end_at: string; status: string; cancelled_by: string | null; meet_link: string | null; calendar_error: string | null; deal_id: string | null; client_id: string | null }>(
      `select id, type_id, name, email, phone, notes, start_at::text, end_at::text, status, cancelled_by, meet_link, calendar_error, deal_id, client_id
         from bookings where agency_id = $1 and start_at > $2::timestamptz - interval '30 days' order by start_at limit 500`,
      [agencyId, now.toISOString()],
    ),
  ]);
  return { types, bookings };
}

/** Horários livres de um tipo para a tela da agência (mesma conta da página pública). */
export async function typeSlots(deps: Pick<BookingDeps, "sql" | "calendarFor">, agencyId: string, id: string, now = new Date()) {
  return availableSlots(deps, await typeOf(deps.sql, agencyId, id), now);
}
