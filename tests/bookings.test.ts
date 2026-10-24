import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { createAgency } from "../src/lib/core/agencies";
import { book, bookingBoard, cancelBooking, cancelByToken, createType, deleteType, publicBooking, updateType, type BookingDeps, type CalendarFor } from "../src/lib/core/bookings";
import { crmBoard } from "../src/lib/core/crm";
import type { EmailMessage } from "../src/lib/core/email";
import { one, type Sql } from "../src/lib/xodos/db";
import { createTestDb } from "./helpers";

let sql: Sql;
before(async () => {
  ({ sql } = await createTestDb());
});

test("agendamentos: horários livres, Google ocupado, marcar com Meet e CRM, conflito, cancelar", async () => {
  const dona = (await one<{ id: string }>(sql, `insert into auth.users (email) values ($1) returning id`, [`d-${randomUUID()}@x.com`]))!.id;
  const { id: agencyId } = await createAgency(sql, dona, { name: "Agência Agenda" });
  const google = (await one<{ id: string }>(sql, `insert into integration_connections (agency_id, provider, label, status, ciphertext) values ($1, 'google', 'G', 'active', 'v1:x') returning id`, [agencyId]))!.id;

  const events: { id: string; start: Date; end: Date }[] = [{ id: "ext", start: new Date("2026-10-23T13:00:00Z"), end: new Date("2026-10-23T14:00:00Z") }];
  const cancelled: string[] = [];
  const calendarFor: CalendarFor = () => ({
    busy: async (from, to) => events.filter((e) => e.start < to && e.end > from),
    create: async (ev) => { const id = "ev" + events.length; events.push({ id, start: ev.start, end: ev.end }); return { id, meet: "https://meet.google.com/abc-defg-hij" }; },
    cancel: async (id) => { cancelled.push(id); events.splice(events.findIndex((e) => e.id === id), 1); },
  });
  const mails: EmailMessage[] = [];
  const deps: BookingDeps = { sql, calendarFor, mailer: async (m) => { mails.push(m); return true; }, appUrl: "https://app.test" };

  await assert.rejects(createType(sql, agencyId, dona, { name: "X", from_hour: 18, to_hour: 9 }), /depois do início/);
  const t = await createType(sql, agencyId, dona, { name: "Diagnóstico gratuito", duration_min: 60, days: [5], from_hour: 9, to_hour: 12, connection_id: google, min_notice_hours: 2, max_days_ahead: 7 });

  // Quinta, 22/10, 08h (Brasília): só a sexta 23/10 está aberta; das 10h às 11h está ocupado no Google.
  const now = new Date("2026-10-22T11:00:00Z");
  const pub = await publicBooking(deps, t.code, now);
  assert.deepEqual(pub.days, [{ day: "2026-10-23", slots: ["09:00", "11:00"] }], "09:30 bate no evento das 10h");

  await assert.rejects(book(deps, t.code, { start: "2026-10-23T10:00:00-03:00", name: "Rafa", email: "rafa@x.com" }, "1.1.1.1", "s", now), /não está mais livre/);
  const b = await book(deps, t.code, { start: "2026-10-23T09:00:00-03:00", name: "Rafael Couto", email: "Rafa@X.com", phone: "(41) 99999-0000" }, "1.1.1.1", "s", now);
  assert.equal(b.meet, "https://meet.google.com/abc-defg-hij");
  assert.match(mails[0].text, /sexta-feira, 23 de outubro, às 09:00/);
  assert.match(mails[0].text, new RegExp(`https://app.test/agenda/cancelar/${b.cancel_token}`));
  assert.deepEqual((await publicBooking(deps, t.code, now)).days, [{ day: "2026-10-23", slots: ["11:00"] }]);

  const [deal] = (await crmBoard(sql, agencyId)).deals;
  assert.deepEqual([deal.company, deal.email, deal.stage, deal.source, deal.next_action_date], ["Rafael Couto", "rafa@x.com", "diagnostico", "Agendamento", "2026-10-23"]);

  // Outro tipo da mesma pessoa também fica ocupado nesse horário.
  const t2 = await createType(sql, agencyId, dona, { name: "Alinhamento", duration_min: 30, days: [5], from_hour: 9, to_hour: 10, max_days_ahead: 7, min_notice_hours: 0 });
  assert.deepEqual((await publicBooking(deps, t2.code, now)).days, [], "a dona já está em reunião das 9h às 10h");

  // O convidado cancela pelo link; o evento sai da agenda e o horário volta.
  const c = await cancelByToken(deps, b.cancel_token);
  assert.deepEqual([c.cancelled, c.already], [true, false]);
  assert.deepEqual(cancelled, ["ev1"]);
  assert.equal((await cancelByToken(deps, b.cancel_token)).already, true);
  assert.deepEqual((await publicBooking(deps, t.code, now)).days[0].slots, ["09:00", "11:00"]);

  // A agência cancela outra; o convidado recebe e-mail.
  const b2 = await book(deps, t.code, { start: "2026-10-23T11:00:00-03:00", name: "Juliana", email: "ju@x.com" }, "2.2.2.2", "s", now);
  await assert.rejects(deleteType(sql, agencyId, t.id, now), /marcada/);
  await cancelBooking(deps, agencyId, b2.id, "Imprevisto");
  assert.match(mails[mails.length - 1].subject, /Cancelada/);
  assert.match(mails[mails.length - 1].text, /Motivo: Imprevisto/);
  await assert.rejects(cancelBooking(deps, agencyId, b2.id), /já foi cancelada/);

  // Desativado some da página pública; limite por IP.
  await updateType(sql, agencyId, t2.id, { active: false });
  await assert.rejects(publicBooking(deps, t2.code, now), /não encontrada/);
  const board = await bookingBoard(sql, agencyId, now);
  assert.deepEqual([board.types.length, board.bookings.length, board.bookings.every((x) => x.status === "cancelada")], [2, 2, true]);
  await deleteType(sql, agencyId, t.id);
});
