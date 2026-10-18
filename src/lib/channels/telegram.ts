import { z } from "zod";
import { IntegrationError, type Fetch } from "../integrations/http";
import { access, loadConnection, readSecret, saveConnection, type IntegrationDeps } from "../integrations/store";
import { one } from "../xodos/db";
import { channelConnection, decideFromChannel, receiveMessage, seenBefore, sendDirect } from "./core";
import { identityFor } from "./pairing";
import { randomToken, safeEqual } from "./security";
import {
  ChannelError,
  integrationDepsOf,
  type Adapters,
  type ChannelAdapter,
  type ChannelDeps,
  type InboundMessage,
  type InboundResult,
  type OutboundApproval,
  type SendContext,
} from "./types";

/**
 * Canal Telegram: cada agência cria um bot no @BotFather (pode ser um por xodó, com o nome
 * dele) e cola o token no Spherum. Conferimos o token com getMe, gravamos cifrado e apontamos
 * o webhook do bot para /api/channels/telegram/<conexão>, com um segredo novo que o Telegram
 * devolve em todo POST (X-Telegram-Bot-Api-Secret-Token).
 *
 * Por enquanto só conversa privada: mensagens em grupo, supergrupo e canal são ignoradas (o
 * bot não sabe quem da equipe está falando com quem, e responder lá exporia a conversa).
 *
 * O envio é texto puro, sem parse_mode: o Markdown do xodó chega como escrito, sem risco de
 * o Telegram recusar a mensagem por uma entidade malformada. Pedidos de aprovação viram
 * botões inline ("ap:<pedido>:1" aprova, ":0" nega).
 *
 * A URL da API leva o token (api.telegram.org/bot<token>/…): nenhuma mensagem de erro daqui
 * usa a URL, e o que vier de fora passa por scrub antes de virar texto.
 */

const PROVIDER = "telegram" as const;
const TELEGRAM_API = "https://api.telegram.org";
const TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const APPROVAL_DATA = /^ap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([01])$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 20_000;
/** Texto do aviso de answerCallbackQuery. */
const ANSWER_MAX = 200;
/** O Telegram desiste de esperar a resposta ao botão depois de alguns segundos. */
const ANSWER_WITHIN_MS = 5_000;
/** Pedidos com botão numa mensagem; acima disso, "aprovar N" por texto ou o app. */
const MAX_BUTTON_ROWS = 20;

export const ONLY_TEXT = "Por enquanto eu só entendo mensagens de texto. Pode escrever o que você precisa?";

/** Corta sem partir emoji ao meio, contando em UTF-16 como o Telegram. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Nome escolhido pela pessoa (ou pelo dono do bot): sem quebras de linha nem caracteres de controle. */
const cleanName = (value: string) => clip(value.replace(/\p{Cc}+/gu, " ").trim(), 100);

export const telegramWebhookUrl = (appUrl: string, connectionId: string) =>
  `${appUrl.replace(/\/+$/, "")}/api/channels/telegram/${connectionId}`;

const sourceOf = (connectionId: string) => `${PROVIDER}:${connectionId}`;

// ---------------------------------------------------------------------------
// Bot API
// ---------------------------------------------------------------------------

type ApiResponse = { ok?: unknown; result?: unknown; description?: unknown; error_code?: unknown; parameters?: { retry_after?: unknown } };

/** Erros do Telegram em mensagens claras; o token nunca entra no texto. */
function telegramError(status: number, body: ApiResponse | null, scrub: (text: string) => string): IntegrationError {
  const code = typeof body?.error_code === "number" ? body.error_code : status;
  // Scrub antes de cortar: um corte no meio do token deixaria um pedaço dele no texto.
  const said = clip(scrub(typeof body?.description === "string" ? body.description : `HTTP ${status}`), 200);
  // 404 é o que o Telegram responde para token que não existe.
  if (code === 401 || code === 404) {
    return new IntegrationError("O Telegram recusou o token do bot (revogado ou trocado no @BotFather).", 401, true);
  }
  if (code === 403) {
    if (/blocked/i.test(said)) {
      return new IntegrationError("A pessoa bloqueou o bot no Telegram. Ela precisa desbloquear e mandar uma mensagem para o xodó poder responder.", 403);
    }
    if (/deactivated/i.test(said)) return new IntegrationError("A conta do Telegram desta pessoa foi apagada.", 403);
    if (/initiate/i.test(said)) {
      return new IntegrationError("O bot não pode começar a conversa: a pessoa precisa mandar uma mensagem para ele primeiro.", 403);
    }
    return new IntegrationError(`O Telegram não deixou o bot mandar mensagem para este chat (${said}).`, 403);
  }
  if (code === 429) {
    const wait = Number(body?.parameters?.retry_after);
    const when = Number.isFinite(wait) && wait > 0 ? ` (liberado em ${Math.ceil(wait)} s)` : "";
    return new IntegrationError(`O Telegram limitou os envios do bot por excesso de mensagens${when}.`, 429);
  }
  if (code >= 500) return new IntegrationError(`O Telegram está instável (${said}).`, 502);
  return new IntegrationError(`O Telegram recusou: ${said}.`, code >= 400 && code < 500 ? code : 502);
}

/** Chamada a um método da Bot API. Resposta com ok:false vira erro (a fila tenta de novo). */
async function telegramCall<T>(http: Fetch, token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  const scrub = (text: string) => (token ? text.split(token).join("<token>") : text);
  let response: Response;
  let text: string;
  try {
    response = await http(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new IntegrationError(`Não consegui falar com o Telegram: ${scrub(error instanceof Error ? error.message : String(error))}`);
  }
  let parsed: ApiResponse | null = null;
  try {
    const value: unknown = text ? JSON.parse(text) : null;
    parsed = value && typeof value === "object" ? (value as ApiResponse) : null;
  } catch {
    // Resposta que não é JSON (proxy, página de erro): fica só o status.
  }
  if (response.ok && parsed?.ok === true) return parsed.result as T;
  throw telegramError(response.status, parsed, scrub);
}

/** Falha que não pode atrapalhar o resto (aviso do botão, tirar os botões). */
async function quietly(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    console.warn("[canais] telegram:", label, "falhou", error instanceof Error ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

export const telegramInput = z.object({
  token: z
    .string()
    .trim()
    .max(200, "Token longo demais.")
    .regex(TOKEN, "Token inválido. Cole o token inteiro que o @BotFather mandou (números, dois-pontos e o código)."),
  label: z.string().trim().min(1).max(60).optional(),
});

const botInfo = z.object({
  id: z.number().int().positive(),
  is_bot: z.literal(true),
  first_name: z.string().min(1).max(200),
  username: z.string().min(1).max(64).optional(),
});

export type TelegramBot = { id: number; username: string | null; name: string };

/**
 * Conecta um bot do Telegram: confere o token (getMe), grava cifrado e aponta o webhook do bot
 * para o Spherum. Reconectar o mesmo bot atualiza a conexão e troca o segredo do webhook.
 */
export async function createTelegramConnection(
  deps: IntegrationDeps,
  agencyId: string,
  raw: unknown,
  createdBy: string | null,
): Promise<{ id: string; bot: TelegramBot }> {
  const input = telegramInput.parse(raw);
  const token = input.token;
  let me: z.infer<typeof botInfo>;
  try {
    const parsed = botInfo.safeParse(await telegramCall(deps.fetch, token, "getMe"));
    if (!parsed.success) throw new IntegrationError("O Telegram não devolveu os dados do bot.", 502);
    me = parsed.data;
  } catch (error) {
    if (error instanceof IntegrationError && error.reauth) {
      throw new IntegrationError("O Telegram recusou o token. Confira o token que o @BotFather mandou (ou gere outro com /token).", 400);
    }
    throw error;
  }
  // O token começa com o id do bot; se não bater, algo está errado do outro lado.
  if (token.split(":")[0] !== String(me.id)) throw new IntegrationError("O Telegram devolveu outro bot para este token.", 502);

  const name = cleanName(me.first_name);
  const username = me.username ? cleanName(me.username) : null;
  const account = String(me.id);
  const webhookSecret = randomToken();
  const save = () =>
    saveConnection(deps, {
      agencyId,
      provider: PROVIDER,
      label: input.label ?? clip(`Telegram ${username ? `@${username}` : name}`, 60),
      account,
      secret: { apiKey: token, extra: { webhook_secret: webhookSecret } },
      metadata: { bot_id: me.id, username, name },
      createdBy,
    });
  const pointWebhook = async (connectionId: string) => {
    try {
      await telegramCall(deps.fetch, token, "setWebhook", {
        url: telegramWebhookUrl(deps.appUrl, connectionId),
        secret_token: webhookSecret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new IntegrationError(`O bot foi conferido, mas o Telegram não aceitou o endereço do webhook: ${message}`, 502);
    }
  };

  // Reconexão: o webhook muda antes de gravar o segredo novo. Se o Telegram recusar, a conexão
  // que já funcionava continua com o segredo que ele ainda manda.
  const previous = await one<{ id: string }>(
    deps.sql,
    `select id from integration_connections where agency_id = $1 and provider = $2 and external_account = $3 and status <> 'revoked'`,
    [agencyId, PROVIDER, account],
  );
  let id: string;
  if (previous) {
    await pointWebhook(previous.id);
    id = await save();
  } else {
    id = await save();
    try {
      await pointWebhook(id);
    } catch (error) {
      await deps.sql.query(`update integration_connections set status = 'error', last_error = $2, updated_at = now() where id = $1`, [
        id,
        clip(error instanceof Error ? error.message : String(error), 500),
      ]);
      throw error;
    }
  }

  // O webhook é um só por bot: outra conexão com o mesmo bot deixou de receber mensagens.
  await deps.sql.query(
    `update integration_connections set status = 'error', last_error = $3, updated_at = now()
      where provider = $4 and external_account = $1 and id <> $2 and status <> 'revoked'`,
    [
      account,
      id,
      "Este bot foi conectado de novo em outro lugar do Spherum e parou de mandar mensagens para cá. Se não foi você, revogue o token no @BotFather e conecte de novo.",
      PROVIDER,
    ],
  );
  return { id, bot: { id: me.id, username, name } };
}

/**
 * Desliga o webhook antes de desconectar, para o Telegram parar de mandar mensagens. Só mexe
 * se o webhook ainda aponta para esta conexão (o bot pode ter sido conectado em outra).
 */
export async function deleteTelegramWebhook(deps: IntegrationDeps, agencyId: string, connectionId: string): Promise<boolean> {
  const row = await loadConnection(deps.sql, agencyId, connectionId);
  if (row.provider !== PROVIDER || row.status === "revoked") return false;
  const token = (await readSecret(deps, row)).apiKey;
  if (!token) return false;
  const info = await telegramCall<{ url?: unknown }>(deps.fetch, token, "getWebhookInfo");
  if (typeof info?.url !== "string" || !info.url.endsWith(`/api/channels/telegram/${row.id}`)) return false;
  await telegramCall(deps.fetch, token, "deleteWebhook", { drop_pending_updates: true });
  return true;
}

export type TelegramHook = { id: string; agencyId: string };

/**
 * Conexão de um POST do webhook, se o segredo do cabeçalho bater. Conexão inexistente,
 * desconectada ou segredo errado dão o mesmo null (a rota responde 401 igual).
 */
export async function telegramHookFor(deps: IntegrationDeps, connectionId: string, header: string | null): Promise<TelegramHook | null> {
  if (!header || !UUID.test(connectionId)) return null;
  const conn = await channelConnection(deps.sql, connectionId, PROVIDER);
  if (!conn) return null;
  const secret = await readSecret(deps, await loadConnection(deps.sql, conn.agencyId, conn.id));
  const expected = secret.extra?.webhook_secret;
  if (typeof expected !== "string" || !expected || !safeEqual(header, expected)) return null;
  return { id: conn.id, agencyId: conn.agencyId };
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };

export type TelegramDecision = { actionId: string; approve: boolean };

export type TelegramCallback = {
  kind: "callback";
  updateId: string;
  callbackId: string;
  userId: string;
  /** Botão de aprovação tocado; null para qualquer outro botão. */
  decision: TelegramDecision | null;
  /** Mensagem com os botões (some quando ela é inacessível ou veio do modo inline). */
  chatId: number | null;
  messageId: number | null;
  /** Os botões que a mensagem tinha, para tirar só a linha do pedido decidido. */
  keyboard: InlineButton[][] | null;
};

export type TelegramEvent =
  | { kind: "text"; updateId: string; chatId: number; userId: string; displayName: string | null; text: string }
  | { kind: "unsupported"; updateId: string; chatId: number; userId: string; displayName: string | null; type: string }
  | TelegramCallback
  | { kind: "ignored"; updateId: string; reason: string };

const userSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});
const chatSchema = z.object({ id: z.number().int(), type: z.string() });
const messageSchema = z.object({
  message_id: z.number().int(),
  chat: chatSchema,
  from: userSchema.optional(),
  text: z.string().optional(),
});
const callbackSchema = z.object({
  id: z.string().min(1).max(200),
  from: userSchema,
  data: z.string().max(256).optional(),
  // Mensagem estranha não impede a decisão nem a resposta ao toque: só fica sem tirar os botões.
  message: z
    .object({ message_id: z.number().int(), chat: chatSchema, reply_markup: z.unknown().optional() })
    .optional()
    .catch(undefined),
});
const updateSchema = z.object({ update_id: z.number().int().nonnegative() });

/** Conteúdos que pedem a explicação de "só texto"; mensagens de serviço passam em silêncio. */
const CONTENT_TYPES = [
  "photo",
  "video",
  "voice",
  "audio",
  "document",
  "sticker",
  "animation",
  "video_note",
  "contact",
  "location",
  "venue",
  "poll",
  "dice",
] as const;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

function displayNameOf(user: z.infer<typeof userSchema>): string | null {
  const full = [user.first_name, user.last_name].filter((part) => part?.trim()).join(" ");
  const name = cleanName(full || user.username || "");
  return name || null;
}

export function approvalFromData(data: string | undefined): TelegramDecision | null {
  const m = data?.trim().match(APPROVAL_DATA);
  return m ? { actionId: m[1].toLowerCase(), approve: m[2] === "1" } : null;
}

/** Só os nossos botões de aprovação, sem o resto do que vier no reply_markup. */
function keyboardOf(markup: unknown): InlineButton[][] | null {
  const rows = record(markup).inline_keyboard;
  if (!Array.isArray(rows)) return null;
  return rows
    .map((row) =>
      (Array.isArray(row) ? row : [])
        .map(record)
        .filter((b) => typeof b.text === "string" && typeof b.callback_data === "string" && APPROVAL_DATA.test(b.callback_data))
        .map((b) => ({ text: b.text as string, callback_data: b.callback_data as string })),
    )
    .filter((row) => row.length > 0);
}

/**
 * Traduz um Update do webhook. Conversa privada com texto vira mensagem; toque em botão vira
 * callback; o resto (grupos, canais, outros bots, mensagens de serviço) fica de fora.
 * Devolve null para o que nem tem update_id.
 */
export function parseTelegramUpdate(update: unknown): TelegramEvent | null {
  const head = updateSchema.safeParse(update);
  if (!head.success) return null;
  const updateId = String(head.data.update_id);
  const body = record(update);

  if (body.callback_query !== undefined) {
    const parsed = callbackSchema.safeParse(body.callback_query);
    if (!parsed.success) return { kind: "ignored", updateId, reason: "botão malformado" };
    const q = parsed.data;
    if (q.from.is_bot) return { kind: "ignored", updateId, reason: "bot" };
    return {
      kind: "callback",
      updateId,
      callbackId: q.id,
      userId: String(q.from.id),
      decision: approvalFromData(q.data),
      chatId: q.message?.chat.id ?? null,
      messageId: q.message?.message_id ?? null,
      keyboard: q.message ? keyboardOf(q.message.reply_markup) : null,
    };
  }

  if (body.message === undefined) return { kind: "ignored", updateId, reason: "tipo de update" };
  const parsed = messageSchema.safeParse(body.message);
  if (!parsed.success) return { kind: "ignored", updateId, reason: "mensagem malformada" };
  const m = parsed.data;
  // Por enquanto, só conversa privada (grupos, supergrupos e canais ficam de fora).
  if (m.chat.type !== "private") return { kind: "ignored", updateId, reason: m.chat.type };
  if (!m.from) return { kind: "ignored", updateId, reason: "sem remetente" };
  if (m.from.is_bot) return { kind: "ignored", updateId, reason: "bot" };
  const base = { updateId, chatId: m.chat.id, userId: String(m.from.id), displayName: displayNameOf(m.from) };
  if (typeof m.text === "string") return { kind: "text", ...base, text: m.text };
  const raw = record(body.message);
  const type = CONTENT_TYPES.find((key) => raw[key] !== undefined);
  return type ? { kind: "unsupported", ...base, type } : { kind: "ignored", updateId, reason: "mensagem de serviço" };
}

function inboundOf(hook: TelegramHook, event: { updateId: string; chatId: number; userId: string; displayName: string | null }, text: string): InboundMessage {
  return {
    provider: PROVIDER,
    connectionId: hook.id,
    agencyId: hook.agencyId,
    eventId: event.updateId,
    externalUser: event.userId,
    displayName: event.displayName,
    conversationKey: String(event.chatId),
    text,
    reply: { chat_id: event.chatId },
    direct: true,
  };
}

/**
 * Processa um Update já verificado: texto vai para o núcleo (que também trata "/start CÓDIGO"
 * como pareamento), botão decide o pedido, e foto, áudio etc. recebem uma explicação curta,
 * no máximo uma vez por hora para cada pessoa vinculada.
 */
export async function handleTelegramUpdate(
  deps: ChannelDeps,
  adapters: Adapters,
  hook: TelegramHook,
  update: unknown,
  opts: { answerWithinMs?: number } = {},
): Promise<InboundResult> {
  const event = parseTelegramUpdate(update);
  if (!event) return { status: "ignored", detail: "malformado" };
  if (event.kind === "ignored") return { status: "ignored", detail: event.reason };
  if (event.kind === "callback") return handleTelegramCallback(deps, adapters, hook, event, opts);
  if (event.kind === "text") return receiveMessage(deps, adapters, inboundOf(hook, event, event.text));

  const { sql } = deps;
  if (await seenBefore(sql, sourceOf(hook.id), event.updateId)) return { status: "duplicate" };
  // Quem não está vinculado não conversa com o xodó (o texto dele recebe a dica do núcleo).
  if (!(await identityFor(sql, hook.agencyId, "telegram", event.userId))) return { status: "unknown_sender" };
  const now = deps.now ? deps.now() : new Date();
  if (!(await seenBefore(sql, `so-texto:${sourceOf(hook.id)}:${event.userId}`, now.toISOString().slice(0, 13)))) {
    await sendDirect(deps, adapters, inboundOf(hook, event, ""), ONLY_TEXT);
  }
  return { status: "ignored", detail: event.type };
}

type Settled = { done: true; outcome: Awaited<ReturnType<typeof decideFromChannel>> } | { done: false; outcome: null; error: unknown };

/**
 * Toque num botão de aprovação: decide pelo núcleo (que confere se a conta está vinculada),
 * responde o toque com o resultado e tira os botões do pedido que não espera mais decisão.
 *
 * A decisão retoma o xodó, o que pode levar minutos, e o Telegram só espera alguns segundos a
 * resposta ao toque. Se demorar, respondemos "recebido" na hora; um erro no fim vira mensagem.
 * Falhas no aviso ou ao tirar os botões nunca desfazem nem atrapalham a decisão.
 */
export async function handleTelegramCallback(
  deps: ChannelDeps,
  adapters: Adapters,
  hook: TelegramHook,
  event: TelegramCallback,
  opts: { answerWithinMs?: number } = {},
): Promise<InboundResult> {
  const { sql } = deps;
  if (await seenBefore(sql, sourceOf(hook.id), event.updateId)) return { status: "duplicate" };
  const integrations = integrationDepsOf(deps);
  let token: string | null = null;
  try {
    token = (await access(integrations, hook.agencyId, hook.id)).accessToken;
  } catch (error) {
    console.warn("[canais] telegram: conexão indisponível para responder o botão", hook.id, error instanceof Error ? error.message : error);
  }
  const answer = (text?: string) =>
    token
      ? quietly("answerCallbackQuery", () =>
          telegramCall(integrations.fetch, token!, "answerCallbackQuery", {
            callback_query_id: event.callbackId,
            ...(text ? { text: clip(text, ANSWER_MAX) } : {}),
          }),
        )
      : Promise.resolve();

  if (!event.decision) {
    await answer();
    return { status: "ignored", detail: "botão desconhecido" };
  }
  const { actionId, approve } = event.decision;

  const decision: Promise<Settled> = decideFromChannel(deps, adapters, {
    provider: PROVIDER,
    agencyId: hook.agencyId,
    externalUser: event.userId,
    actionId,
    approve,
  }).then(
    (outcome): Settled => ({ done: true, outcome }),
    (error: unknown): Settled => ({ done: false, outcome: null, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    decision,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.answerWithinMs ?? ANSWER_WITHIN_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!early) await answer(approve ? "Recebido! Aprovando…" : "Recebido! Negando…");
  const settled = early ?? (await decision);

  const message = settled.outcome?.message ?? "Não consegui concluir a decisão. Confira o pedido no Spherum.";
  if (early) await answer(message);
  else if (!settled.outcome?.ok) {
    const chatId = event.chatId ?? Number(event.userId);
    await sendDirect(deps, adapters, inboundOf(hook, { updateId: event.updateId, chatId, userId: event.userId, displayName: null }, ""), message);
  }

  // Pedido que não espera mais decisão perde os botões; o toque de quem não pode decidir não tira nada.
  if (token && event.chatId !== null && event.messageId !== null) {
    await quietly("editMessageReplyMarkup", async () => {
      const pending = await one(sql, `select 1 from xodo_actions where id = $1 and agency_id = $2 and status = 'pending'`, [actionId, hook.agencyId]);
      if (pending) return;
      const rest = (event.keyboard ?? []).filter((row) => !row.some((b) => approvalFromData(b.callback_data)?.actionId === actionId));
      if (event.keyboard && rest.length === event.keyboard.length) return;
      await telegramCall(integrations.fetch, token!, "editMessageReplyMarkup", {
        chat_id: event.chatId,
        message_id: event.messageId,
        reply_markup: { inline_keyboard: rest },
      });
    });
  }

  if (!settled.done) {
    console.warn("[canais] telegram: decisão falhou", hook.id, settled.error instanceof Error ? settled.error.message : settled.error);
    return { status: "failed", detail: message };
  }
  return { status: "decided", runId: settled.outcome.runId, detail: message };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

const targetSchema = z.object({ chat_id: z.union([z.number().int(), z.string().regex(/^-?\d{1,20}$/)]) });

/**
 * Uma linha por pedido: [Aprovar N] [Negar N] (sem número quando há um pedido só). Só ids no
 * formato UUID, o que garante o callback_data em 41 bytes (o limite é 64).
 */
export function approvalKeyboard(approvals: OutboundApproval[]): InlineButton[][] {
  const numbered = approvals.length > 1 || approvals.some((a) => a.index > 1);
  return approvals
    .filter((a) => UUID.test(a.actionId))
    .slice(0, MAX_BUTTON_ROWS)
    .map((a) => {
      const n = numbered ? ` ${a.index}` : "";
      return [
        { text: `Aprovar${n}`, callback_data: `ap:${a.actionId.toLowerCase()}:1` },
        { text: `Negar${n}`, callback_data: `ap:${a.actionId.toLowerCase()}:0` },
      ];
    });
}

async function sendMessage(ctx: SendContext, payload: Record<string, unknown>) {
  try {
    await telegramCall(ctx.deps.fetch, ctx.access.accessToken, "sendMessage", payload);
  } catch (error) {
    // Token recusado: marca a conexão, para o app pedir o token novo em vez de tentar para sempre
    // (uma desconectada no meio do caminho continua desconectada).
    if (error instanceof IntegrationError && error.reauth) {
      await ctx.deps.sql.query(
        `update integration_connections set status = 'expired', last_error = $2, updated_at = now() where id = $1 and status <> 'revoked'`,
        [ctx.access.connection.id, error.message],
      );
    }
    throw error;
  }
}

export const telegramAdapter: ChannelAdapter = {
  provider: PROVIDER,
  maxChars: 4096,
  async send(ctx, message) {
    const target = targetSchema.safeParse(ctx.target);
    if (!target.success) throw new ChannelError("A conversa não tem o chat do Telegram para responder.");
    const keyboard = approvalKeyboard(message.approvals);
    const text = message.text.trim() ? message.text : keyboard.length ? "Pedidos de aprovação:" : "";
    if (!text) return;
    await sendMessage(ctx, {
      chat_id: target.data.chat_id,
      text,
      // Sem prévia de links. É o substituto de disable_web_page_preview (Bot API 7.0); os dois juntos
      // são tratados como exclusivos pelas bibliotecas, então vai só o atual.
      link_preview_options: { is_disabled: true },
      ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  },
};
