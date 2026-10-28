import { z } from "zod";
import { dayIn } from "../../xodos/budget";
import type { Category } from "../../xodos/policy";
import { appCall, ToolError, openApp, type ToolContext, type ToolDef } from "../../xodos/tools";
import { requestJson } from "../http";
import { clip, internalOnly, tool } from "./common";

/**
 * Google Agenda: ver compromissos, criar, alterar, cancelar e responder convites. Convite para
 * gente de fora da empresa é "envio" (o Google manda e-mail para ela); o resto é "alteracao".
 */

const CALENDAR = "https://www.googleapis.com/calendar/v3";

type Agenda = Awaited<ReturnType<typeof openApp>>;
type When = { date?: string; dateTime?: string; timeZone?: string };
type Attendee = { email: string; responseStatus?: string; self?: boolean; organizer?: boolean };
type Event = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: When;
  end?: When;
  attendees?: Attendee[];
  organizer?: { email?: string; self?: boolean };
  hangoutLink?: string;
  htmlLink?: string;
};

const call = <T = Record<string, unknown>>(a: Agenda, path: string, init: Parameters<typeof requestJson>[2] = {}) =>
  appCall(() => requestJson<T>(a.http, `${CALENDAR}${path}`, { ...init, bearer: a.accessToken }));

const calendarPath = (id: string) => `/calendars/${encodeURIComponent(id)}`;

/** Deslocamento do fuso num instante, como "-03:00". */
export function offsetOf(timezone: string, at: Date): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

const nextDay = (day: string, n = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Meia-noite de um dia no fuso do xodó, em RFC 3339. */
const midnight = (day: string, timezone: string) => `${day}T00:00:00${offsetOf(timezone, new Date(`${day}T12:00:00Z`))}`;

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const hasOffset = (v: string) => /(Z|[+-]\d{2}:\d{2})$/.test(v);

/** Data (dia inteiro) ou data e hora; sem fuso, vale o fuso do xodó. */
function when(value: string, timezone: string): When {
  return isDate(value) ? { date: value } : { dateTime: value, timeZone: timezone };
}

/** Fim padrão: uma hora depois (ou o próprio dia, se for dia inteiro). */
function defaultEnd(start: string): string {
  if (isDate(start)) return start;
  if (hasOffset(start)) return new Date(Date.parse(start) + 3_600_000).toISOString();
  return new Date(Date.parse(`${start}Z`) + 3_600_000).toISOString().slice(0, 19);
}

/** No Google, o fim de um evento de dia inteiro é o dia seguinte ao último dia. */
const endWhen = (start: string, end: string, timezone: string): When => (isDate(start) ? { date: nextDay(end) } : when(end, timezone));

function eventOut(e: Event) {
  return {
    id: e.id,
    titulo: e.summary ?? "(sem título)",
    inicio: e.start?.dateTime ?? e.start?.date ?? null,
    fim: e.end?.dateTime ?? (e.end?.date ? nextDay(e.end.date, -1) : null),
    dia_inteiro: Boolean(e.start?.date),
    local: e.location ?? null,
    descricao: e.description ? clip(e.description, 800) : null,
    participantes: (e.attendees ?? []).map((a) => ({ email: a.email, resposta: a.responseStatus ?? null, voce: a.self ?? false })),
    organizador: e.organizer?.email ?? null,
    link_meet: e.hangoutLink ?? null,
    link: e.htmlLink ?? null,
    cancelado: e.status === "cancelled",
  };
}

/** Convite que sai para alguém de fora é "envio"; o resto é "alteracao". */
function inviteCategory(a: Agenda, attendees: string[], notify: boolean): Category {
  if (!notify || !attendees.length) return "alteracao";
  return internalOnly(a.connection.external_account ?? "", attendees) ? "alteracao" : "envio";
}

const dateOrTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/, "Use AAAA-MM-DD ou AAAA-MM-DDTHH:MM")
  .describe("AAAA-MM-DD para dia inteiro, ou AAAA-MM-DDTHH:MM no fuso do xodó");
const agenda = z.string().max(200).default("primary").describe('Agenda: "primary" (a principal) ou o e-mail de uma agenda compartilhada');
const guests = z.array(z.email()).max(100);

const createInput = z.object({
  titulo: z.string().min(1).max(300),
  inicio: dateOrTime,
  fim: dateOrTime.optional().describe("Padrão: uma hora depois (ou o mesmo dia, se for dia inteiro)"),
  descricao: z.string().max(8000).optional(),
  local: z.string().max(500).optional(),
  convidados: guests.default([]),
  avisar_convidados: z.boolean().default(true),
  criar_meet: z.boolean().default(false).describe("Cria um link do Google Meet"),
  agenda,
});

const updateInput = z.object({
  id: z.string().min(1).max(200),
  agenda,
  titulo: z.string().min(1).max(300).optional(),
  inicio: dateOrTime.optional(),
  fim: dateOrTime.optional(),
  descricao: z.string().max(8000).optional(),
  local: z.string().max(500).optional(),
  adicionar_convidados: guests.default([]),
  remover_convidados: guests.default([]),
  avisar_convidados: z.boolean().default(true),
});
type UpdateInput = z.infer<typeof updateInput>;

async function getEvent(a: Agenda, calendar: string, id: string) {
  return call<Event>(a, `${calendarPath(calendar)}/events/${encodeURIComponent(id)}`);
}

function attendeesAfter(e: Event, i: Pick<UpdateInput, "adicionar_convidados" | "remover_convidados">): Attendee[] {
  const remove = new Set(i.remover_convidados.map((x) => x.toLowerCase()));
  const kept = (e.attendees ?? []).filter((x) => !remove.has(x.email.toLowerCase()));
  const have = new Set(kept.map((x) => x.email.toLowerCase()));
  return [...kept, ...i.adicionar_convidados.filter((x) => !have.has(x.toLowerCase())).map((email) => ({ email }))];
}

function sendUpdates(notify: boolean) {
  return notify ? "all" : "none";
}

export const CALENDAR_TOOLS: ToolDef[] = [
  tool({
    name: "ver_agenda",
    description: "Compromissos da agenda num período (padrão: hoje e os próximos 7 dias). Pode filtrar por texto.",
    category: "leitura",
    app: "calendar",
    input: z.object({
      de: z.iso.date().optional(),
      ate: z.iso.date().optional().describe("Último dia (inclusive)"),
      busca: z.string().max(200).optional(),
      agenda,
    }),
    summarize: () => "ver a agenda",
    async execute(ctx: ToolContext, i) {
      const a = await openApp(ctx, "calendar");
      const tz = ctx.xodo.timezone;
      const from = i.de ?? dayIn(tz, ctx.now);
      const to = i.ate ?? nextDay(from, 7);
      if (to < from) throw new ToolError("A data final vem antes da inicial.");
      if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw new ToolError("Período máximo de 3 meses.");
      const params = new URLSearchParams({
        timeMin: midnight(from, tz),
        timeMax: midnight(nextDay(to), tz),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100",
        timeZone: tz,
      });
      if (i.busca) params.set("q", i.busca);
      const { items = [] } = await call<{ items?: Event[] }>(a, `${calendarPath(i.agenda)}/events?${params}`);
      return { periodo: { inicio: from, fim: to }, fuso: tz, eventos: items.map(eventOut) };
    },
  }),
  tool({
    name: "criar_evento",
    description: "Cria um evento na agenda, com convidados e link do Meet se quiser. Convidar gente de fora segue a autonomia de envio.",
    category: "alteracao",
    app: "calendar",
    input: createInput,
    summarize: (i) =>
      `criar o evento "${i.titulo}" em ${i.inicio}${i.convidados.length ? ` com ${i.convidados.join(", ")}` : ""}`,
    async categoryFor(ctx, i) {
      return inviteCategory(await openApp(ctx, "calendar"), i.convidados, i.avisar_convidados);
    },
    async execute(ctx, i) {
      const a = await openApp(ctx, "calendar");
      const tz = ctx.xodo.timezone;
      const end = i.fim ?? defaultEnd(i.inicio);
      if (isDate(i.inicio) !== isDate(end)) throw new ToolError("Início e fim precisam ser os dois dia inteiro ou os dois com horário.");
      const body = {
        summary: i.titulo,
        description: i.descricao,
        location: i.local,
        start: when(i.inicio, tz),
        end: endWhen(i.inicio, end, tz),
        attendees: i.convidados.map((email) => ({ email })),
        ...(i.criar_meet
          ? { conferenceData: { createRequest: { requestId: `${ctx.runId}-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } }
          : {}),
      };
      const params = new URLSearchParams({ sendUpdates: sendUpdates(i.avisar_convidados), conferenceDataVersion: i.criar_meet ? "1" : "0" });
      const created = await call<Event>(a, `${calendarPath(i.agenda)}/events?${params}`, { method: "POST", json: body });
      return eventOut(created);
    },
  }),
  tool({
    name: "alterar_evento",
    description: "Muda título, horário, descrição, local ou convidados de um evento.",
    category: "alteracao",
    app: "calendar",
    input: updateInput,
    summarize: (i) => `alterar o evento ${i.id}`,
    async categoryFor(ctx, i) {
      const a = await openApp(ctx, "calendar");
      const after = attendeesAfter(await getEvent(a, i.agenda, i.id), i).map((x) => x.email);
      return inviteCategory(a, after, i.avisar_convidados);
    },
    async execute(ctx, i) {
      const a = await openApp(ctx, "calendar");
      const tz = ctx.xodo.timezone;
      const current = await getEvent(a, i.agenda, i.id);
      const patch: Record<string, unknown> = {};
      if (i.titulo !== undefined) patch.summary = i.titulo;
      if (i.descricao !== undefined) patch.description = i.descricao;
      if (i.local !== undefined) patch.location = i.local;
      if (i.inicio !== undefined) {
        const end = i.fim ?? defaultEnd(i.inicio);
        patch.start = when(i.inicio, tz);
        patch.end = endWhen(i.inicio, end, tz);
      } else if (i.fim !== undefined) {
        const start = current.start?.date ?? current.start?.dateTime ?? "";
        patch.end = endWhen(start, i.fim, tz);
      }
      if (i.adicionar_convidados.length || i.remover_convidados.length) patch.attendees = attendeesAfter(current, i);
      if (!Object.keys(patch).length) throw new ToolError("Nada para mudar.");
      const params = new URLSearchParams({ sendUpdates: sendUpdates(i.avisar_convidados) });
      const updated = await call<Event>(a, `${calendarPath(i.agenda)}/events/${encodeURIComponent(i.id)}?${params}`, {
        method: "PATCH",
        json: patch,
      });
      return eventOut(updated);
    },
  }),
  tool({
    name: "cancelar_evento",
    description: "Cancela (apaga) um evento da agenda e, se quiser, avisa os convidados.",
    category: "exclusao",
    app: "calendar",
    input: z.object({ id: z.string().min(1).max(200), agenda, avisar_convidados: z.boolean().default(true) }),
    summarize: (i) => `cancelar o evento ${i.id}`,
    async execute(ctx, i) {
      const a = await openApp(ctx, "calendar");
      const params = new URLSearchParams({ sendUpdates: sendUpdates(i.avisar_convidados) });
      await call(a, `${calendarPath(i.agenda)}/events/${encodeURIComponent(i.id)}?${params}`, { method: "DELETE" });
      return { cancelado: i.id };
    },
  }),
  tool({
    name: "responder_convite",
    description: "Aceita, recusa ou responde talvez a um convite recebido. Quem organizou recebe a resposta.",
    category: "envio",
    app: "calendar",
    input: z.object({ id: z.string().min(1).max(200), resposta: z.enum(["aceitar", "recusar", "talvez"]), agenda }),
    summarize: (i) => `${i.resposta} o convite ${i.id}`,
    async categoryFor(ctx, i) {
      const a = await openApp(ctx, "calendar");
      const e = await getEvent(a, i.agenda, i.id);
      return inviteCategory(a, e.organizer?.email ? [e.organizer.email] : [], true);
    },
    async execute(ctx, i) {
      const a = await openApp(ctx, "calendar");
      const e = await getEvent(a, i.agenda, i.id);
      const status = { aceitar: "accepted", recusar: "declined", talvez: "tentative" }[i.resposta];
      if (!e.attendees?.some((x) => x.self)) throw new ToolError("Você não está entre os convidados deste evento.");
      const attendees = e.attendees.map((x) => (x.self ? { ...x, responseStatus: status } : x));
      await call(a, `${calendarPath(i.agenda)}/events/${encodeURIComponent(i.id)}?sendUpdates=all`, { method: "PATCH", json: { attendees } });
      return { evento: i.id, resposta: status };
    },
  }),
];
