import { requestJson } from "../integrations/http";
import { access, type IntegrationDeps } from "../integrations/store";
import type { CalendarFor } from "./bookings";

/** Google Agenda dos agendamentos: horários ocupados (eventos), criar com Meet e cancelar. */

const BASE = "https://www.googleapis.com/calendar/v3/calendars/";
type When = { date?: string; dateTime?: string };
type Ev = { id: string; status?: string; transparency?: string; start?: When; end?: When; hangoutLink?: string; attendees?: { self?: boolean; responseStatus?: string }[] };

const instant = (w: When | undefined, end: boolean) =>
  w?.dateTime ? new Date(w.dateTime) : w?.date ? new Date(`${w.date}T00:00:00-03:00`) : end ? new Date(8.64e15) : new Date(0);

export const googleCalendar = (deps: IntegrationDeps): CalendarFor => (agencyId, connectionId, calendarId) => {
  const base = `${BASE}${encodeURIComponent(calendarId)}`;
  const token = async () => (await access(deps, agencyId, connectionId)).accessToken;
  return {
    async busy(from, to) {
      const bearer = await token();
      const out: { start: Date; end: Date }[] = [];
      let pageToken: string | undefined;
      do {
        const p = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", maxResults: "250", ...(pageToken ? { pageToken } : {}) });
        const r = await requestJson<{ items?: Ev[]; nextPageToken?: string }>(deps.fetch, `${base}/events?${p}`, { bearer });
        for (const e of r.items ?? []) {
          // Cancelado, marcado como "livre" ou recusado não ocupa o horário.
          if (e.status === "cancelled" || e.transparency === "transparent" || e.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
          out.push({ start: instant(e.start, false), end: instant(e.end, true) });
        }
        pageToken = r.nextPageToken;
      } while (pageToken && out.length < 2500);
      return out;
    },
    async create(ev) {
      const bearer = await token();
      const p = new URLSearchParams({ conferenceDataVersion: "1", sendUpdates: "all" });
      const created = await requestJson<Ev>(deps.fetch, `${base}/events?${p}`, {
        method: "POST", bearer,
        json: {
          summary: ev.summary, description: ev.description,
          start: { dateTime: ev.start.toISOString() }, end: { dateTime: ev.end.toISOString() },
          attendees: [{ email: ev.attendee }],
          conferenceData: { createRequest: { requestId: `agenda-${ev.start.getTime()}-${Math.random().toString(36).slice(2, 10)}`, conferenceSolutionKey: { type: "hangoutsMeet" } } },
        },
      });
      return { id: created.id, meet: created.hangoutLink ?? null };
    },
    async cancel(eventId) {
      const bearer = await token();
      await requestJson(deps.fetch, `${base}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE", bearer });
    },
  };
};

/** Dependências dos agendamentos no servidor (Google Agenda, e-mail e endereço do app). */
export async function bookingDeps(sql: import("../xodos/db").Sql) {
  const { serverIntegrations } = await import("../integrations");
  const { mailerFromEnv } = await import("./email");
  const integrations = { sql, ...serverIntegrations() };
  return { sql, calendarFor: googleCalendar(integrations), mailer: mailerFromEnv(), appUrl: integrations.appUrl.replace(/\/$/, "") };
}
