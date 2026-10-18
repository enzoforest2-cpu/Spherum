import { z, ZodError } from "zod";
import { IntegrationError } from "../integrations/http";
import { metaGraph } from "../integrations/oauth-providers";
import { loadConnection, readSecret, saveConnection, type IntegrationDeps } from "../integrations/store";
import { channelConnection, decideFromChannel, receiveMessage, seenBefore, sendDirect } from "./core";
import { identityFor } from "./pairing";
import { randomToken, safeEqual } from "./security";
import {
  ChannelError,
  type Adapters,
  type ChannelAdapter,
  type ChannelDeps,
  type InboundMessage,
  type InboundResult,
  type OutboundApproval,
  type SendContext,
} from "./types";

/**
 * WhatsApp oficial (WhatsApp Business Cloud API da Meta), um número por conexão da agência.
 *
 * A conexão é manual: a agência cria o app no painel da Meta e cola aqui o ID do número, o
 * token permanente de um usuário do sistema e a chave secreta do app. Conferimos o número na
 * Meta antes de gravar e devolvemos o endereço do webhook e o token de verificação, que ela
 * cola no painel (assinando o campo "messages").
 *
 * A Meta só aceita texto livre até 24 horas depois da última mensagem da pessoa; depois disso,
 * só modelos aprovados, que o Spherum não usa. Esse erro vira uma explicação clara na fila.
 */

const PROVIDER = "whatsapp_cloud" as const;
/** wa_id: o número da pessoa, só dígitos com o código do país. */
const WA_ID = /^\d{5,20}$/;
const PHONE_NUMBER_ID = /^\d{5,30}$/;
/** Botão de aprovação: "ap:<id do pedido>:1" aprova, ":0" nega. */
const APPROVAL_BUTTON = /^ap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([01])$/i;
/** Mensagem mais velha que isso não tem resposta possível (a janela fechou); a Meta reenvia por dias. */
const STALE_MS = 24 * 60 * 60 * 1000;
const GRAPH_TIMEOUT_MS = 20_000;
/** Texto máximo de uma mensagem com botões (os títulos "Aprovar"/"Negar" cabem nos 20 caracteres). */
const BUTTON_BODY_MAX = 1024;

export const ONLY_TEXT = "Por enquanto eu só entendo mensagens de texto. Pode escrever o que você precisa?";

/** Corta em caracteres (sem partir emoji ao meio), com reticências. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

type GraphError = { error?: { message?: unknown; code?: unknown; error_data?: { details?: unknown } } };

const RATE_LIMITED = { message: "O WhatsApp limitou os envios deste número por excesso de mensagens. A fila tenta de novo daqui a pouco.", status: 429 };
const NO_PERMISSION = { message: "O token não tem permissão para usar este número (confira a permissão whatsapp_business_messaging).", status: 403 };

/** Erros da Meta que merecem explicação própria, pelo código. */
const KNOWN_ERRORS: Record<number, { message: string; status: number; reauth?: boolean }> = {
  131047: {
    message:
      "Passou a janela de 24 horas do WhatsApp: a Meta só aceita mensagem livre até 24 horas depois da última mensagem da pessoa. Ela precisa escrever de novo para o xodó poder responder.",
    status: 409,
  },
  131026: { message: "O WhatsApp não conseguiu entregar para este número (sem WhatsApp, aplicativo desatualizado ou termos não aceitos).", status: 422 },
  131030: { message: "Este número não está na lista de destinatários permitidos do número de teste da Meta.", status: 422 },
  133010: { message: "O número da agência não está registrado na Cloud API. Termine o cadastro no painel da Meta.", status: 409 },
  190: { message: "A Meta recusou o token do WhatsApp (vencido ou revogado). Gere um token permanente novo no painel da Meta e reconecte.", status: 401, reauth: true },
  10: NO_PERMISSION,
  200: NO_PERMISSION,
  4: RATE_LIMITED,
  80007: RATE_LIMITED,
  130429: RATE_LIMITED,
  131048: RATE_LIMITED,
  131056: RATE_LIMITED,
};

function graphError(status: number, body: unknown): IntegrationError {
  const err = (body && typeof body === "object" ? (body as GraphError).error : undefined) ?? {};
  const code = typeof err.code === "number" ? err.code : null;
  const known = code !== null ? KNOWN_ERRORS[code] : undefined;
  if (known) return new IntegrationError(known.message, known.status, known.reauth ?? false);
  const said = clip(String(err.message ?? `HTTP ${status}`), 200);
  const details = typeof err.error_data?.details === "string" ? ` (${clip(err.error_data.details, 200)})` : "";
  return new IntegrationError(`A Meta recusou: ${said}${details}${code !== null ? ` [código ${code}]` : ""}.`, status >= 500 ? 502 : status);
}

/** Chamada à Graph API com o token no cabeçalho; o erro sai com o código da Meta traduzido. */
async function graph<T>(deps: IntegrationDeps, token: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await deps.fetch(`${metaGraph()}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new IntegrationError(`Não consegui falar com o WhatsApp: ${error instanceof Error ? error.message : error}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Resposta que não é JSON (proxy, página de erro): fica só o status.
  }
  if (!response.ok) throw graphError(response.status, parsed);
  return (parsed ?? {}) as T;
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

const noSpaces = /^\S+$/;

export const whatsappCloudInput = z.object({
  phone_number_id: z
    .string()
    .trim()
    .regex(PHONE_NUMBER_ID, "O ID do número de telefone tem só dígitos (no painel da Meta: WhatsApp → Configuração da API)."),
  access_token: z.string().trim().min(20, "Token curto demais.").max(2000).regex(noSpaces, "O token não pode ter espaços."),
  app_secret: z.string().trim().min(16, "Chave secreta do app curta demais.").max(200).regex(noSpaces, "A chave secreta não pode ter espaços."),
  label: z.string().trim().min(1).max(60).optional(),
});

const phoneInfo = z.object({
  id: z.string().optional(),
  display_phone_number: z.string().min(1).max(40),
  verified_name: z.string().max(200).nullish(),
});

/**
 * Conecta um número do WhatsApp oficial. Confere na Meta que o token enxerga o número antes de
 * gravar; o token de verificação do webhook é novo a cada conexão (ou reconexão).
 */
export async function createWhatsappCloudConnection(
  deps: IntegrationDeps,
  agencyId: string,
  raw: unknown,
  createdBy: string | null,
): Promise<{ id: string; webhookUrl: string; verifyToken: string }> {
  const input = whatsappCloudInput.parse(raw);
  let info: z.infer<typeof phoneInfo>;
  try {
    info = phoneInfo.parse(await graph(deps, input.access_token, `${input.phone_number_id}?fields=display_phone_number,verified_name`));
  } catch (error) {
    if (error instanceof IntegrationError) {
      if (error.reauth) throw new IntegrationError("A Meta recusou o token. Use o token permanente de um usuário do sistema com acesso a este número.", 400);
      throw new IntegrationError(
        `Não consegui confirmar o número na Meta. ${error.message} Confira o ID do número de telefone (não é o número em si) e se o token tem acesso a ele.`,
        error.status >= 500 ? 502 : 400,
      );
    }
    if (error instanceof ZodError) throw new IntegrationError("A Meta não devolveu os dados do número.", 502);
    throw error;
  }
  if (info.id && info.id !== input.phone_number_id) throw new IntegrationError("A Meta devolveu outro número.", 502);

  const verifyToken = randomToken();
  const id = await saveConnection(deps, {
    agencyId,
    provider: PROVIDER,
    label: input.label ?? clip(`WhatsApp ${info.verified_name || info.display_phone_number}`, 60),
    account: input.phone_number_id,
    secret: { accessToken: input.access_token, extra: { app_secret: input.app_secret, verify_token: verifyToken } },
    metadata: {
      phone_number_id: input.phone_number_id,
      display_phone_number: info.display_phone_number,
      verified_name: info.verified_name ?? null,
    },
    createdBy,
  });
  return { id, webhookUrl: `${deps.appUrl.replace(/\/+$/, "")}/api/channels/whatsapp/${id}`, verifyToken };
}

export type WhatsappCloudWebhook = { id: string; agencyId: string; phoneNumberId: string; appSecret: string; verifyToken: string };

/** O que a rota de entrada precisa da conexão: agência, número e os dois segredos do webhook. */
export async function loadWhatsappCloudWebhook(deps: IntegrationDeps, connectionId: string): Promise<WhatsappCloudWebhook | null> {
  const conn = await channelConnection(deps.sql, connectionId, PROVIDER);
  if (!conn) return null;
  const secret = await readSecret(deps, await loadConnection(deps.sql, conn.agencyId, conn.id));
  const appSecret = secret.extra?.app_secret;
  const verifyToken = secret.extra?.verify_token;
  const phoneNumberId = conn.metadata.phone_number_id;
  if (typeof appSecret !== "string" || typeof verifyToken !== "string" || typeof phoneNumberId !== "string") return null;
  if (!appSecret || !verifyToken || !phoneNumberId) return null;
  return { id: conn.id, agencyId: conn.agencyId, phoneNumberId, appSecret, verifyToken };
}

/**
 * Confirmação do webhook (GET): hub.mode=subscribe e o token de verificação da conexão.
 * Devolve o hub.challenge para ecoar, ou null (a rota responde 403).
 */
export function verifyWhatsappChallenge(params: URLSearchParams, verifyToken: string | null | undefined): string | null {
  const challenge = params.get("hub.challenge");
  const token = params.get("hub.verify_token");
  if (params.get("hub.mode") !== "subscribe" || !verifyToken || !token || !challenge) return null;
  // A Meta manda um número; ecoar qualquer outra coisa não tem motivo.
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(challenge)) return null;
  return safeEqual(token, verifyToken) ? challenge : null;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

type EventBase = {
  /** Número da agência que recebeu (value.metadata.phone_number_id). */
  phoneNumberId: string;
  /** wamid da mensagem. */
  eventId: string;
  /** wa_id de quem mandou. */
  from: string;
  name: string | null;
  sentAt: Date | null;
};

export type WhatsappCloudEvent =
  | (EventBase & { kind: "text"; text: string })
  | (EventBase & { kind: "decision"; actionId: string; approve: boolean })
  | (EventBase & { kind: "unsupported"; type: string });

/** Tipos que não pedem resposta: reação a uma mensagem, aviso de troca de número, boas-vindas. */
const SILENT_TYPES = new Set(["reaction", "system", "request_welcome"]);

const contactSchema = z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).optional() });
const messageSchema = z.object({
  id: z.string().min(1).max(200),
  from: z.string().regex(WA_ID),
  timestamp: z.string().regex(/^\d{1,12}$/).optional(),
  type: z.string().min(1).max(40),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .object({ type: z.string().optional(), button_reply: z.object({ id: z.string(), title: z.string().optional() }).optional() })
    .optional(),
  button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
});

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

function approvalOf(id: string | undefined): { actionId: string; approve: boolean } | null {
  const m = id?.trim().match(APPROVAL_BUTTON);
  return m ? { actionId: m[1].toLowerCase(), approve: m[2] === "1" } : null;
}

/**
 * Traduz o corpo do webhook (entry[].changes[] do campo "messages") em mensagens de texto,
 * toques nos botões de aprovação e mensagens que ainda não entendemos. Status de entrega
 * (value.statuses) e o que vier malformado ficam de fora.
 */
export function parseWhatsappCloud(body: unknown): WhatsappCloudEvent[] {
  const out: WhatsappCloudEvent[] = [];
  for (const entry of list(record(body).entry)) {
    for (const change of list(record(entry).changes)) {
      const c = record(change);
      if (c.field !== "messages") continue;
      const value = record(c.value);
      const phoneNumberId = record(value.metadata).phone_number_id;
      if (typeof phoneNumberId !== "string" || !phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const raw of list(value.contacts)) {
        const contact = contactSchema.safeParse(raw);
        // O nome do perfil é escolhido pela pessoa: sem quebras de linha nem caracteres de controle.
        const name = contact.success ? contact.data.profile?.name?.replace(/\p{Cc}+/gu, " ").trim() : undefined;
        if (contact.success && name) names.set(contact.data.wa_id, clip(name, 100));
      }
      for (const raw of list(value.messages)) {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) continue;
        const m = parsed.data;
        if (SILENT_TYPES.has(m.type)) continue;
        const base: EventBase = {
          phoneNumberId,
          eventId: m.id,
          from: m.from,
          name: names.get(m.from) ?? null,
          sentAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : null,
        };
        if (m.type === "text" && m.text) {
          out.push({ ...base, kind: "text", text: m.text.body });
          continue;
        }
        // Botão de resposta (interactive) ou de modelo (button). Toque em outro botão vale como o texto dele.
        const tapped =
          m.type === "interactive" && m.interactive?.button_reply
            ? { id: m.interactive.button_reply.id, label: m.interactive.button_reply.title }
            : m.type === "button" && m.button
              ? { id: m.button.payload, label: m.button.text }
              : null;
        if (tapped) {
          const decision = approvalOf(tapped.id);
          if (decision) out.push({ ...base, kind: "decision", ...decision });
          else if (tapped.label?.trim()) out.push({ ...base, kind: "text", text: tapped.label });
          else out.push({ ...base, kind: "unsupported", type: m.type });
          continue;
        }
        out.push({ ...base, kind: "unsupported", type: m.type });
      }
    }
  }
  return out;
}

export type WhatsappCloudResult = InboundResult & { eventId: string };

/**
 * Processa um webhook já verificado: texto vai para o núcleo, botão decide o pedido e responde
 * o resultado, e o resto (foto, áudio…) recebe uma explicação curta, no máximo uma vez por hora
 * para cada pessoa vinculada (quem não está vinculado não conversa com o xodó).
 */
export async function handleWhatsappCloud(
  deps: ChannelDeps,
  adapters: Adapters,
  hook: Pick<WhatsappCloudWebhook, "id" | "agencyId" | "phoneNumberId">,
  payload: unknown,
): Promise<WhatsappCloudResult[]> {
  const now = deps.now ? deps.now() : new Date();
  const source = `${PROVIDER}:${hook.id}`;
  const results: WhatsappCloudResult[] = [];
  for (const event of parseWhatsappCloud(payload)) {
    // Outro número do mesmo app da Meta: não é desta conexão.
    if (event.phoneNumberId !== hook.phoneNumberId) continue;
    if (event.sentAt && now.getTime() - event.sentAt.getTime() > STALE_MS) {
      results.push({ eventId: event.eventId, status: "ignored", detail: "antiga" });
      continue;
    }
    const msg: InboundMessage = {
      provider: PROVIDER,
      connectionId: hook.id,
      agencyId: hook.agencyId,
      eventId: event.eventId,
      externalUser: event.from,
      displayName: event.name,
      conversationKey: event.from,
      text: event.kind === "text" ? event.text : "",
      reply: { to: event.from },
      direct: true,
    };
    try {
      let result: InboundResult;
      if (event.kind === "text") {
        result = await receiveMessage(deps, adapters, msg);
      } else if (await seenBefore(deps.sql, source, event.eventId)) {
        result = { status: "duplicate" };
      } else if (event.kind === "decision") {
        const outcome = await decideFromChannel(deps, adapters, {
          provider: PROVIDER,
          agencyId: hook.agencyId,
          externalUser: event.from,
          actionId: event.actionId,
          approve: event.approve,
        });
        await sendDirect(deps, adapters, msg, outcome.message);
        result = { status: "decided", runId: outcome.runId, detail: outcome.message };
      } else if (!(await identityFor(deps.sql, hook.agencyId, "whatsapp", event.from))) {
        result = { status: "unknown_sender" };
      } else {
        if (!(await seenBefore(deps.sql, `so-texto:${source}:${event.from}`, now.toISOString().slice(0, 13)))) {
          await sendDirect(deps, adapters, msg, ONLY_TEXT);
        }
        result = { status: "ignored", detail: event.type };
      }
      results.push({ eventId: event.eventId, ...result });
    } catch (error) {
      console.warn("[canais] whatsapp: evento falhou", hook.id, error instanceof Error ? error.message : error);
      results.push({ eventId: event.eventId, status: "failed" });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

const targetSchema = z.object({ to: z.string().regex(WA_ID) });

function approvalButtons(approval: OutboundApproval, total: number) {
  const summary = approval.summary.trim() || "Pedido de aprovação";
  return {
    type: "button",
    body: { text: clip(total > 1 || approval.index > 1 ? `${approval.index}. ${summary}` : summary, BUTTON_BODY_MAX) },
    action: {
      buttons: [
        { type: "reply", reply: { id: `ap:${approval.actionId}:1`, title: "Aprovar" } },
        { type: "reply", reply: { id: `ap:${approval.actionId}:0`, title: "Negar" } },
      ],
    },
  };
}

async function postMessage(ctx: SendContext, phoneNumberId: string, payload: Record<string, unknown>) {
  try {
    await graph(ctx.deps, ctx.access.accessToken, `${phoneNumberId}/messages`, payload);
  } catch (error) {
    // Token recusado: marca a conexão, para o app pedir a reconexão em vez de tentar para sempre.
    if (error instanceof IntegrationError && error.reauth) {
      await ctx.deps.sql.query(`update integration_connections set status = 'expired', last_error = $2, updated_at = now() where id = $1`, [
        ctx.access.connection.id,
        error.message,
      ]);
    }
    throw error;
  }
}

export const whatsappCloudAdapter: ChannelAdapter = {
  provider: PROVIDER,
  maxChars: 4096,
  async send(ctx, message) {
    const target = targetSchema.safeParse(ctx.target);
    if (!target.success) throw new ChannelError("A conversa não tem o número do WhatsApp para responder.");
    const { connection } = ctx.access;
    const phoneNumberId = String(connection.metadata.phone_number_id ?? connection.external_account ?? "");
    if (!PHONE_NUMBER_ID.test(phoneNumberId)) throw new ChannelError("A conexão do WhatsApp está sem o ID do número.");
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to: target.data.to };
    if (message.text.trim()) {
      await postMessage(ctx, phoneNumberId, { ...base, type: "text", text: { body: message.text, preview_url: false } });
    }
    for (const approval of message.approvals) {
      await postMessage(ctx, phoneNumberId, { ...base, type: "interactive", interactive: approvalButtons(approval, message.approvals.length) });
    }
  },
};
