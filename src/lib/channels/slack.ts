import { z } from "zod";
import { access } from "../integrations/store";
import { requestJson, requestText, type Fetch } from "../integrations/http";
import { one, parseJson, type Sql } from "../xodos/db";
import { decideFromChannel, receiveMessage } from "./core";
import { chunkText } from "./outbox";
import { extractPairingCode, identityFor } from "./pairing";
import { readBody, sha256Hex, verifySlackSignature } from "./security";
import { fireSlackTriggers } from "./triggers";
import {
  ChannelError,
  integrationDepsOf,
  type Adapters,
  type ChannelAdapter,
  type ChannelDeps,
  type InboundMessage,
  type InboundResult,
  type OutboundApproval,
} from "./types";

/**
 * Canal Slack: um app do Spherum instalado no workspace de cada agência (o login OAuth das
 * integrações). A conexão guarda o team_id como conta e o token do bot.
 *
 * Entra pelo Events API (menção ao bot em canal e mensagem direta) e pelos botões de
 * aprovação (interatividade). As duas rotas verificam a assinatura com o signing secret do
 * app antes de qualquer coisa, respondem na hora (o Slack desiste depois de 3 s) e fazem o
 * trabalho em segundo plano.
 *
 * Mensagem comum em canal (sem menção) não vira conversa: só dispara os gatilhos "slack".
 */

const SLACK_API = "https://slack.com/api";
/** Limite de texto de um bloco section do Block Kit. */
const SECTION_MAX = 3000;
/** Blocos por mensagem. Cada pedido usa 2; o que não couber fica para o app ou "aprovar N". */
const MAX_BLOCKS = 50;
const MAX_BUTTONS = 20;
const SLACK_ID = /^[A-Z0-9]{2,40}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;
const AP_VALUE = /^ap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([01])$/;
const NOT_LINKED =
  "Só quem está vinculado à equipe no Spherum pode decidir pedidos. Gere um código no Spherum (Integrações → Canais) e me mande por mensagem direta.";

// ---------------------------------------------------------------------------
// Texto: Slack → xodó e xodó → Slack
// ---------------------------------------------------------------------------

/** O Slack exige &, < e > escapados; escapar também impede o texto de chamar @channel ou @here. */
export const escapeMrkdwn = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown do xodó no mrkdwn do Slack: títulos e negrito viram *negrito*, links viram <url|texto>. */
export function toMrkdwn(text: string): string {
  return escapeMrkdwn(text)
    .replace(/^#{1,6}[ \t]+(.+)$/gm, (_, title: string) => `*${title.replace(/\*+/g, "").trim()}*`)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/\[([^\]\n|]{1,200})\]\((https?:\/\/[^\s)|]+)\)/g, "<$2|$1>");
}

/** Texto que chega do Slack, legível para o xodó: sem a menção ao bot, links e canais por extenso. */
export function fromSlackText(text: string, botUserId: string | null): string {
  let out = text;
  if (botUserId) out = out.split(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g")).join(" ");
  return out
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `#${name || id}`)
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Corta o texto original até a versão escapada caber no limite (sem partir um &amp; no meio). */
function fitEscaped(text: string, max: number): string {
  let cut = text.length;
  while (cut > 0 && escapeMrkdwn(text.slice(0, cut)).length > max) cut = Math.floor(cut * 0.9);
  return cut < text.length ? `${escapeMrkdwn(text.slice(0, cut))}…` : escapeMrkdwn(text);
}

/** Texto em blocos section de até 3000 caracteres já convertidos (escapar pode alongar: aí divide de novo). */
function sections(text: string, max = SECTION_MAX): string[] {
  return chunkText(text, max)
    .filter((piece) => piece.trim())
    .flatMap((piece) => {
      const md = toMrkdwn(piece);
      return md.length <= SECTION_MAX ? [md] : sections(piece, Math.max(1, Math.floor(piece.length / 2)));
    });
}

/** Blocos da mensagem com pedidos de aprovação: o texto e, para cada pedido, o resumo e os botões. */
export function slackBlocks(text: string, approvals: OutboundApproval[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = sections(text).map((md, i) => ({
    type: "section",
    block_id: `xodo_txt_${i}`,
    text: { type: "mrkdwn", text: md },
  }));
  // Sobra um bloco para o aviso dos pedidos que não couberam.
  const room = Math.max(0, Math.floor((MAX_BLOCKS - 1 - blocks.length) / 2));
  const shown = approvals.slice(0, Math.min(MAX_BUTTONS, room));
  for (const a of shown) {
    blocks.push({
      type: "section",
      block_id: `xodo_ap_${a.index}`,
      text: { type: "mrkdwn", text: `*${a.index}.* ${fitEscaped(a.summary, SECTION_MAX - 10)}` },
    });
    blocks.push({
      type: "actions",
      block_id: `xodo_btn_${a.index}`,
      elements: [
        { type: "button", action_id: "xodo_aprovar", style: "primary", text: { type: "plain_text", text: "Aprovar" }, value: `ap:${a.actionId}:1` },
        { type: "button", action_id: "xodo_negar", style: "danger", text: { type: "plain_text", text: "Negar" }, value: `ap:${a.actionId}:0` },
      ],
    });
  }
  if (approvals.length > shown.length) {
    const rest = approvals.length - shown.length;
    blocks.push(note(`Há mais ${rest} pedido${rest > 1 ? "s" : ""}: decida no Spherum ou responda "aprovar N".`));
  }
  return blocks;
}

const note = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

const targetSchema = z.object({
  channel: z.string().regex(SLACK_ID),
  thread_ts: z.string().regex(SLACK_TS).nullish(),
});

/**
 * Envia pelo chat.postMessage com o token do bot. O nome do xodó vira o autor da mensagem
 * (username), o que exige a permissão chat:write.customize: instalações antigas, sem ela,
 * mandam com o nome do app. Resposta { ok: false } vira exceção e a fila tenta de novo.
 */
export const slackAdapter: ChannelAdapter = {
  provider: "slack",
  maxChars: 3900,
  async send(ctx, message) {
    const target = targetSchema.safeParse(ctx.target);
    if (!target.success) throw new Error("Destino do Slack inválido na conversa.");
    if (!message.text.trim() && !message.approvals.length) return;
    const customize = (ctx.access.connection.scopes ?? []).includes("chat:write.customize");
    const body: Record<string, unknown> = {
      channel: target.data.channel,
      text: toMrkdwn(message.text) || "Pedido de aprovação",
      unfurl_links: false,
      ...(target.data.thread_ts ? { thread_ts: target.data.thread_ts } : {}),
      ...(ctx.xodoName && customize ? { username: ctx.xodoName.slice(0, 80) } : {}),
      ...(message.approvals.length ? { blocks: slackBlocks(message.text, message.approvals) } : {}),
    };
    await requestJson(ctx.deps.fetch, `${SLACK_API}/chat.postMessage`, { method: "POST", json: body, bearer: ctx.access.accessToken });
  },
};

// ---------------------------------------------------------------------------
// Entrada: assinatura e conexão
// ---------------------------------------------------------------------------

/** Lê o corpo cru e confere a assinatura do Slack; sem signing secret configurado, recusa. */
export async function readSlackRequest(request: Request, signingSecret: string | undefined, now = new Date()): Promise<string> {
  if (!signingSecret) throw new ChannelError("O Slack ainda não foi configurado no Spherum (SLACK_SIGNING_SECRET).", 503);
  const raw = await readBody(request);
  const headers = {
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
  };
  if (!verifySlackSignature(signingSecret, headers, raw, now)) throw new ChannelError("Assinatura do Slack inválida.", 401);
  return raw;
}

export type SlackConnection = { id: string; agencyId: string; teamId: string; botUserId: string | null; metadata: Record<string, unknown> };

/** Pistas de quem deve atender: quem escreveu, em que canal e o código de pareamento, se veio um. */
export type TeamHint = { user?: string; channel?: string; code?: string | null };

/**
 * Conexões Slack ativas de um workspace, da preferida para a última. O app do Spherum é um só,
 * então o mesmo workspace pode ter sido conectado por mais de uma agência (ex.: agência e
 * cliente que dividem o Slack). A conversa fica com uma só, nesta ordem: a agência do código de
 * pareamento que veio na mensagem; a agência em que quem escreve já está vinculado; a que tem
 * xodó ativo para aquele canal; a que tem xodó para o workspace todo (scope '*'); a atualizada
 * por último. Uma conexão sem xodó não teria quem responder.
 */
async function teamConnections(sql: Sql, teamId: string, hint: TeamHint = {}): Promise<SlackConnection[]> {
  if (!SLACK_ID.test(teamId)) return [];
  const rows = await sql.query<{ id: string; agency_id: string; metadata: unknown }>(
    `select c.id, c.agency_id, c.metadata from integration_connections c
      where c.provider = 'slack' and c.external_account = $1 and c.status in ('active', 'error')
      order by
        exists (select 1 from channel_pairing_codes p where p.agency_id = c.agency_id and p.code_hash = $2) desc,
        exists (select 1 from channel_identities i
                 where i.agency_id = c.agency_id and i.provider = 'slack' and i.external_user = $3) desc,
        exists (select 1 from xodo_channels x join xodos o on o.id = x.xodo_id
                 where x.connection_id = c.id and x.enabled and o.status = 'active' and x.scope = $4) desc,
        exists (select 1 from xodo_channels x join xodos o on o.id = x.xodo_id
                 where x.connection_id = c.id and x.enabled and o.status = 'active' and x.scope = '*') desc,
        c.updated_at desc`,
    [teamId, hint.code ? sha256Hex(hint.code) : null, hint.user ? `${teamId}:${hint.user}` : null, hint.channel ?? "*"],
  );
  return rows.map((row) => {
    const metadata = parseJson<Record<string, unknown>>(row.metadata) ?? {};
    const bot = typeof metadata.bot_user_id === "string" && SLACK_ID.test(metadata.bot_user_id) ? metadata.bot_user_id : null;
    return { id: row.id, agencyId: row.agency_id, teamId, botUserId: bot, metadata };
  });
}

/** Conexão que atende uma mensagem do workspace (a ordem de preferência está em teamConnections). */
export async function slackConnectionForTeam(sql: Sql, teamId: string, hint: TeamHint = {}): Promise<SlackConnection | null> {
  return (await teamConnections(sql, teamId, hint))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Events API
// ---------------------------------------------------------------------------

export type SlackEvent =
  | { kind: "url_verification"; challenge: string }
  | { kind: "ignored"; reason: string }
  | {
      /** mention: @bot num canal; direct: mensagem direta; channel: mensagem comum num canal (gatilhos). */
      kind: "mention" | "direct" | "channel";
      eventId: string;
      teamId: string;
      /** Workspace de quem escreveu (difere do teamId em canais compartilhados com outra empresa). */
      userTeam: string | null;
      channel: string;
      user: string;
      text: string;
      ts: string;
      threadTs: string | null;
    };

const envelopeSchema = z.object({
  type: z.string().max(50),
  challenge: z.string().max(500).optional(),
  team_id: z.string().max(40).optional(),
  event_id: z.string().max(100).optional(),
  event: z.record(z.string(), z.unknown()).optional(),
});

const str = (value: unknown, pattern?: RegExp): string | null =>
  typeof value === "string" && value && (!pattern || pattern.test(value)) ? value : null;

/** Subtipos que ainda são mensagem de uma pessoa (resposta também mandada ao canal, arquivo com texto). */
const HUMAN_SUBTYPES = new Set(["thread_broadcast", "file_share"]);

/**
 * Traduz o corpo do Events API (já verificado). Fica só o que interessa: menção ao bot em canal,
 * mensagem direta e mensagem comum de pessoa num canal. Bots, edições, mensagens apagadas e
 * eventos de outro tipo são ignorados aqui; o bot da própria conexão e pessoas de outro
 * workspace, depois, quando a conexão é conhecida.
 */
export function parseSlackEvent(body: unknown): SlackEvent {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return { kind: "ignored", reason: "formato desconhecido" };
  const env = parsed.data;
  if (env.type === "url_verification") {
    return env.challenge ? { kind: "url_verification", challenge: env.challenge } : { kind: "ignored", reason: "sem challenge" };
  }
  if (env.type !== "event_callback" || !env.event) return { kind: "ignored", reason: `tipo ${env.type}` };
  const e = env.event;
  const teamId = str(env.team_id, SLACK_ID);
  const eventId = str(env.event_id);
  if (!teamId || !eventId) return { kind: "ignored", reason: "sem workspace ou id do evento" };
  if (e.bot_id || e.subtype === "bot_message") return { kind: "ignored", reason: "mensagem de bot" };
  if (typeof e.subtype === "string" && !HUMAN_SUBTYPES.has(e.subtype)) return { kind: "ignored", reason: `subtipo ${e.subtype}` };

  const user = str(e.user, SLACK_ID);
  const channel = str(e.channel, SLACK_ID);
  const ts = str(e.ts, SLACK_TS);
  if (!user || !channel || !ts) return { kind: "ignored", reason: "sem pessoa, canal ou horário" };

  let kind: "mention" | "direct" | "channel";
  if (e.type === "app_mention") {
    // Em mensagem direta quem atende é o evento message (channel_type "im").
    if (channel.startsWith("D")) return { kind: "ignored", reason: "menção em mensagem direta" };
    kind = "mention";
  } else if (e.type === "message") {
    if (e.channel_type === "im") kind = "direct";
    else if (e.channel_type === "channel" || e.channel_type === "group") kind = "channel";
    else return { kind: "ignored", reason: `conversa ${String(e.channel_type)}` };
  } else {
    return { kind: "ignored", reason: `evento ${String(e.type)}` };
  }
  return {
    kind,
    eventId,
    teamId,
    userTeam: str(e.user_team, SLACK_ID) ?? str(e.team, SLACK_ID),
    channel,
    user,
    text: typeof e.text === "string" ? e.text : "",
    ts,
    threadTs: str(e.thread_ts, SLACK_TS),
  };
}

export type SlackEventResult = InboundResult | { status: "trigger"; fired: number };

/** Nome de quem escreve (users.info), só para quem está se vinculando; falhar não impede nada. */
async function displayNameOf(deps: ChannelDeps, conn: SlackConnection, user: string): Promise<string | null> {
  try {
    const a = await access(integrationDepsOf(deps), conn.agencyId, conn.id);
    const r = await requestJson<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>(
      deps.integrations.fetch,
      `${SLACK_API}/users.info?${new URLSearchParams({ user })}`,
      { bearer: a.accessToken, timeoutMs: 5_000 },
    );
    const u = r.user;
    const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name;
    return name ? name.slice(0, 100) : null;
  } catch (error) {
    console.warn("[canais] slack: users.info falhou", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Menções a pessoas ou ao bot (<@U123> ou <@U123|nome>). */
const USER_MENTION = /<@[A-Z0-9]+(?:\|[^>]*)?>/g;

/**
 * Leva um evento traduzido adiante: menção e mensagem direta viram conversa com o xodó
 * (receiveMessage, que também descarta repetições pelo event_id); mensagem comum em canal
 * dispara os gatilhos de todas as agências que conectaram o workspace.
 */
export async function handleSlackEvent(deps: ChannelDeps, adapters: Adapters, event: SlackEvent): Promise<SlackEventResult> {
  if (event.kind === "url_verification" || event.kind === "ignored") return { status: "ignored" };
  // Em canal compartilhado com outra empresa, quem é de fora não conversa nem dispara gatilho.
  if (event.userTeam && event.userTeam !== event.teamId) return { status: "ignored", detail: "pessoa de outro workspace" };

  if (event.kind === "channel") {
    const conns = await teamConnections(deps.sql, event.teamId);
    if (!conns.length) return { status: "ignored", detail: "workspace sem conexão ativa" };
    // O bot não dispara gatilho; a menção a ele também chega como app_mention, que é quem responde.
    const targets = conns.filter((c) => !c.botUserId || (event.user !== c.botUserId && !event.text.includes(`<@${c.botUserId}`)));
    if (!targets.length) return { status: "ignored", detail: "menção ou o próprio bot" };
    let fired = 0;
    for (const conn of targets) {
      fired += await fireSlackTriggers(deps, {
        agencyId: conn.agencyId,
        connectionId: conn.id,
        channel: event.channel,
        user: event.user,
        text: fromSlackText(event.text, conn.botUserId),
        ts: event.ts,
        eventId: event.eventId,
      });
    }
    return { status: "trigger", fired };
  }

  const mention = event.kind === "mention";
  const code = extractPairingCode(event.text.replace(USER_MENTION, " "));
  const conn = await slackConnectionForTeam(deps.sql, event.teamId, { user: event.user, channel: mention ? event.channel : undefined, code });
  if (!conn) return { status: "ignored", detail: "workspace sem conexão ativa" };
  if (conn.botUserId && event.user === conn.botUserId) return { status: "ignored", detail: "o próprio bot" };

  const text = fromSlackText(event.text, conn.botUserId);
  const externalUser = `${conn.teamId}:${event.user}`;
  const identity = await identityFor(deps.sql, conn.agencyId, "slack", externalUser);
  const displayName = identity?.displayName ?? (code ? await displayNameOf(deps, conn, event.user) : null);
  const thread = event.threadTs ?? event.ts;
  const msg: InboundMessage = {
    provider: "slack",
    connectionId: conn.id,
    agencyId: conn.agencyId,
    eventId: event.eventId,
    externalUser,
    displayName,
    conversationKey: mention ? `${event.channel}:${thread}` : event.channel,
    scope: mention ? event.channel : undefined,
    text,
    reply: mention ? { channel: event.channel, thread_ts: thread } : { channel: event.channel },
    direct: !mention,
  };
  return receiveMessage(deps, adapters, msg);
}

// ---------------------------------------------------------------------------
// Botões de aprovação
// ---------------------------------------------------------------------------

/** Payload da interatividade: o Slack manda application/x-www-form-urlencoded com payload=JSON. */
export function parseInteractionBody(raw: string): unknown {
  const payload = new URLSearchParams(raw).get("payload");
  if (!payload) throw new ChannelError("Interação sem payload.", 400);
  try {
    return JSON.parse(payload);
  } catch {
    throw new ChannelError("Payload inválido.", 400);
  }
}

const interactionSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string().regex(SLACK_ID) }).nullish(),
  user: z.object({ id: z.string().regex(SLACK_ID), team_id: z.string().regex(SLACK_ID).nullish() }),
  response_url: z.string().max(500).nullish(),
  actions: z.array(z.object({ action_id: z.string().max(255), value: z.string().max(2000).nullish() })).min(1).max(10),
  message: z.object({ text: z.string().max(40_000).nullish(), blocks: z.array(z.unknown()).max(50).nullish() }).nullish(),
});

/** Só respondemos para o response_url do próprio Slack (nunca para um endereço vindo de fora). */
function isSlackResponseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

async function respond(http: Fetch, url: string | null | undefined, body: Record<string, unknown>) {
  if (!url || !isSlackResponseUrl(url)) return;
  try {
    await requestText(http, url, { method: "POST", json: body, timeoutMs: 10_000 });
  } catch (error) {
    console.warn("[canais] slack: resposta ao botão falhou", error instanceof Error ? error.message : error);
  }
}

const ephemeral = (text: string) => ({ response_type: "ephemeral", replace_original: false, text });

/** Pedido por trás de um bloco de botões nosso. */
function buttonsOf(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; elements?: unknown };
  if (b.type !== "actions" || !Array.isArray(b.elements)) return null;
  for (const el of b.elements) {
    const value = el && typeof el === "object" ? (el as { value?: unknown }).value : null;
    const m = typeof value === "string" ? value.match(AP_VALUE) : null;
    if (m) return m[1];
  }
  return null;
}

const STATUS_NOTE: Record<string, string> = {
  approved: "Aprovado.",
  executing: "Aprovado.",
  executed: "Aprovado e feito.",
  failed: "Aprovado, mas não deu certo.",
  denied: "Negado.",
  expired: "Expirou.",
};

/** Estado de cada pedido no banco (só os da agência). */
async function actionStatuses(sql: Sql, agencyId: string, ids: string[]): Promise<Map<string, string>> {
  const rows = await sql.query<{ id: string; status: string }>(`select id, status from xodo_actions where agency_id = $1 and id = any($2::uuid[])`, [
    agencyId,
    [...new Set(ids)],
  ]);
  return new Map(rows.map((r) => [r.id, r.status]));
}

/**
 * Mensagem atualizada depois da decisão: os botões do pedido decidido viram o resultado e os
 * dos outros pedidos seguem o estado do banco (assim duas decisões quase juntas não trazem de
 * volta botões de um pedido que já foi decidido).
 */
function settledMessage(
  message: { text?: string | null; blocks?: unknown[] | null } | null | undefined,
  status: Map<string, string>,
  clicked: string,
  label: string,
): Record<string, unknown> {
  const blocks = message?.blocks ?? [];
  if (!blocks.length) return { replace_original: true, text: [message?.text, label].filter(Boolean).join("\n\n") };
  const next = blocks.map((block) => {
    const id = buttonsOf(block);
    if (!id) return block;
    if (id === clicked) return note(label);
    const s = status.get(id);
    return s === "pending" ? block : note(STATUS_NOTE[s ?? ""] ?? "Pedido encerrado.");
  });
  return { replace_original: true, text: message?.text || label, blocks: next };
}

/**
 * Agência do pedido, pela conversa do Slack em que ele foi feito. Assim o botão só decide
 * pedidos de conversas daquele workspace e vale mesmo quando duas agências dividem o Slack.
 */
async function actionConnection(sql: Sql, teamId: string, actionId: string) {
  return one<{ agency_id: string; connection_id: string }>(
    sql,
    `select a.agency_id, ic.id as connection_id from xodo_actions a
       join xodo_runs r on r.id = a.run_id
       join xodo_conversations c on c.id = r.conversation_id
       join integration_connections ic on ic.id = c.connection_id
      where a.id = $1 and ic.provider = 'slack' and ic.external_account = $2 and ic.status in ('active', 'error')`,
    [actionId, teamId],
  );
}

export type InteractionResult = { status: "ignored" | "denied" | "decided" | "failed"; message: string };

/**
 * Clique em "Aprovar" ou "Negar". O pedido precisa ser de uma conversa daquele workspace, e só
 * decide quem é dele e está vinculado a alguém da equipe; para os outros, uma resposta que só a
 * própria pessoa vê, e os botões ficam. Decidido, a mensagem é atualizada pelo response_url,
 * sem os botões daquele pedido.
 */
export async function handleSlackInteraction(deps: ChannelDeps, adapters: Adapters, payload: unknown): Promise<InteractionResult> {
  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) return { status: "ignored", message: "Interação desconhecida." };
  const p = parsed.data;
  let choice: { actionId: string; approve: boolean } | null = null;
  for (const a of p.actions) {
    const m = a.value?.match(AP_VALUE);
    const expected = m?.[2] === "1" ? "xodo_aprovar" : "xodo_negar";
    if (m && a.action_id === expected) {
      choice = { actionId: m[1], approve: m[2] === "1" };
      break;
    }
  }
  if (!choice) return { status: "ignored", message: "Botão desconhecido." };

  const http = deps.integrations.fetch;
  const teamId = p.team?.id ?? p.user.team_id ?? null;
  const conn = teamId ? await actionConnection(deps.sql, teamId, choice.actionId) : null;
  if (!teamId || !conn) {
    await respond(http, p.response_url, ephemeral("Não achei este pedido entre as conversas deste Slack com o Spherum."));
    return { status: "ignored", message: "pedido fora deste workspace" };
  }
  if ((p.user.team_id ?? teamId) !== teamId) {
    await respond(http, p.response_url, ephemeral("Só a equipe da agência pode decidir os pedidos do xodó."));
    return { status: "denied", message: "pessoa de outro workspace" };
  }
  const agencyId = conn.agency_id;
  const externalUser = `${teamId}:${p.user.id}`;
  if (!(await identityFor(deps.sql, agencyId, "slack", externalUser))) {
    await respond(http, p.response_url, ephemeral(NOT_LINKED));
    return { status: "denied", message: NOT_LINKED };
  }

  // Nulo: a decisão (ou a continuação do xodó depois dela) quebrou no meio.
  let outcome: { ok: boolean; message: string } | null;
  try {
    outcome = await decideFromChannel(deps, adapters, {
      provider: "slack",
      agencyId,
      externalUser,
      actionId: choice.actionId,
      approve: choice.approve,
    });
  } catch (error) {
    console.error("[canais] slack: decisão pelo botão falhou", error instanceof Error ? error.message : error);
    outcome = null;
  }
  const blockIds = (p.message?.blocks ?? []).map(buttonsOf).filter((id): id is string => Boolean(id));
  const status = await actionStatuses(deps.sql, agencyId, [choice.actionId, ...blockIds]);
  if (!outcome?.ok && status.get(choice.actionId) === "pending") {
    // Nada foi decidido: avisa só quem clicou e os botões ficam para tentar de novo.
    const message = outcome?.message ?? "Não consegui decidir agora. Tente de novo ou decida no Spherum.";
    await respond(http, p.response_url, ephemeral(escapeMrkdwn(message)));
    return { status: "failed", message };
  }
  const who = `${choice.approve ? "Aprovado" : "Negado"} por <@${p.user.id}>`;
  const label = !outcome ? `${who}, mas o xodó não conseguiu continuar. Veja no Spherum.` : outcome.ok ? who : escapeMrkdwn(outcome.message);
  await respond(http, p.response_url, settledMessage(p.message, status, choice.actionId, label));
  return outcome?.ok ? { status: "decided", message: outcome.message } : { status: "failed", message: outcome?.message ?? label };
}
