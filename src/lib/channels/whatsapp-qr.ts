import { randomBytes } from "node:crypto";
import { z } from "zod";
import { IntegrationError, type Fetch } from "../integrations/http";
import { access, loadConnection, readSecret, saveConnection, type ConnectionRow, type IntegrationDeps } from "../integrations/store";
import { json, type Sql } from "../xodos/db";
import { assertPublicUrl, type Resolver } from "../xodos/net";
import { channelConnection, receiveMessage } from "./core";
import { pendingInThread } from "./outbox";
import { randomToken, safeEqual, sha256Hex } from "./security";
import { ChannelError, type Adapters, type ChannelAdapter, type ChannelDeps, type InboundMessage, type InboundResult, type OutboundApproval, type SendContext } from "./types";

/**
 * WhatsApp por QR Code (NÃO oficial), por um gateway Evolution API v2 que a agência hospeda ou
 * contrata. O gateway abre uma sessão do WhatsApp Web (Baileys) num número da agência; o
 * Spherum só conversa com o gateway, pela chave dele (cabeçalho "apikey").
 *
 * RISCOS (a tela mostra WHATSAPP_QR_RISKS antes de conectar, e a conexão exige accept_risks):
 *  - viola os termos do WhatsApp: o número pode ser banido a qualquer momento, sem aviso;
 *  - use um número dedicado, nunca o principal da agência;
 *  - a sessão cai (celular sem internet, aparelho desconectado) e precisa de QR de novo;
 *  - o gateway vê todas as mensagens do número e pode forjar mensagens (até "aprovar") em nome de
 *    quem está vinculado: hospede você mesmo ou confie no fornecedor;
 *  - não serve para disparos em massa nem para falar com clientes, só com a equipe;
 *  - não há garantia de entrega.
 *
 * Segurança:
 *  - A Evolution não assina os webhooks. A autenticação é um token aleatório no caminho da URL
 *    (/api/channels/whatsapp-qr/<conexão>/<token>); guardamos só o hash dele. Quem tem a URL (o
 *    gateway) fala por qualquer número: por isso o aviso nos riscos.
 *  - O corpo do webhook traz a apikey da instância: nunca registre o corpo em log.
 *  - O endereço do gateway passa pela guarda contra rede interna ao conectar e de novo antes de
 *    cada chamada (o DNS pode mudar depois), e redirecionamentos não são seguidos.
 *  - Botões não são garantidos fora da API oficial: aprovação vai por texto ("aprovar"/"negar").
 *  - Mensagens nossas (fromMe), de grupos, de status e antigas (o gateway reenvia o que chegou
 *    com a sessão fora) ficam de fora, para o xodó não responder a si mesmo nem ao passado.
 */

const PROVIDER = "whatsapp_qr" as const;

export const WHATSAPP_QR_RISKS: readonly string[] = [
  "Não é a API oficial: viola os termos de uso do WhatsApp, e o número pode ser banido a qualquer momento, sem aviso.",
  "Use um número dedicado ao xodó, nunca o número principal da agência.",
  "A sessão cai de tempos em tempos (celular sem internet, aparelho desconectado) e é preciso ler o QR Code de novo.",
  "O gateway vê todas as mensagens desse número e pode forjar mensagens (até aprovações) em nome da equipe: hospede você mesmo ou contrate um fornecedor de confiança.",
  "Não use para disparos em massa nem para falar com clientes: é só para a equipe conversar com o xodó.",
  "Não há garantia de entrega: mensagens podem atrasar ou se perder.",
];

export type WhatsappQrState = "conectado" | "aguardando_qr" | "desconectado";

/** Número de quem fala: só dígitos, com o código do país. */
const NUMBER = /^\d{5,20}$/;
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{2,59}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** randomToken() dá 32 caracteres base64url; aceitamos uma folga. */
const WEBHOOK_TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_QR_CHARS = 200_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
/** O create espera 5 s pelo QR e o connect espera 2 s antes de responder. */
const SLOW_TIMEOUT_MS = 35_000;
/** Mensagem mais velha que isso chegou com a sessão fora do ar: responder agora confunde. */
const STALE_MS = 60 * 60 * 1000;
/** Itens por webhook (data pode vir como lista). */
const MAX_ITEMS = 50;
const STATES = new Set(["open", "connecting", "close", "refused"]);
const EVENTS = ["MESSAGES_UPSERT", "CONNECTION_UPDATE"];
export const SESSION_DROPPED = "A sessão do WhatsApp caiu. Leia o QR Code de novo em Integrações → Canais.";

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

/** Corta em caracteres (sem partir emoji ao meio), com reticências. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Tira segredos de uma mensagem que pode ir para o banco ou para a tela. */
function redact(text: string, secrets: (string | null | undefined)[]): string {
  return secrets.reduce<string>((out, s) => (s && s.length >= 6 ? out.split(s).join("***") : out), text);
}

// ---------------------------------------------------------------------------
// Gateway (Evolution API v2)
// ---------------------------------------------------------------------------

type Gateway = { base: string; instance: string; apiKey: string };
type CallOpts = { resolve?: Resolver; timeoutMs?: number; secrets?: string[] };

/** Erro do gateway; guarda o status HTTP original (o status do erro é o que a nossa rota devolve). */
class GatewayError extends IntegrationError {
  constructor(
    message: string,
    status: number,
    reauth: boolean,
    readonly httpStatus: number,
  ) {
    super(message, status, reauth);
  }
}

/** Endereço do gateway, público e sem ? nem # (vale ao conectar e antes de cada chamada). */
async function publicBase(raw: string, resolve?: Resolver): Promise<string> {
  let url: URL;
  try {
    url = await assertPublicUrl(raw, resolve);
  } catch (error) {
    throw new IntegrationError(`Endereço do gateway recusado: ${error instanceof Error ? error.message : "endereço inválido."}`, 400);
  }
  if (url.search || url.hash) throw new IntegrationError("Informe o endereço do gateway sem ? nem #.", 400);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Mensagem que a Evolution mandou: { status, error, response: { message } } ou { error: true, message }.
 * Os segredos saem antes do corte (um token cortado ao meio não seria reconhecido).
 */
function gatewayMessage(body: unknown, secrets: string[]): { text: string | null; noWhatsapp: boolean } {
  const b = record(body);
  const raw = record(b.response).message ?? b.message ?? (typeof b.error === "string" ? b.error : null);
  const items = (Array.isArray(raw) ? raw : [raw]).flat(2);
  const noWhatsapp = items.some((item) => record(item).exists === false);
  const text = items
    .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? JSON.stringify(item) : ""))
    // O connect devolve "[object Object]" quando o erro interno é um objeto.
    .filter((item) => item && item !== "[object Object]")
    .join("; ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: text ? clip(redact(text, secrets), 200) : null, noWhatsapp };
}

function gatewayError(httpStatus: number, body: unknown, secrets: string[]): GatewayError {
  const { text: said, noWhatsapp } = gatewayMessage(body, secrets);
  if (httpStatus === 401) {
    return new GatewayError("O gateway recusou a chave (apikey). Confira a chave da Evolution API e reconecte.", 400, true, httpStatus);
  }
  if (noWhatsapp) return new GatewayError("Este número não tem WhatsApp.", 422, false, httpStatus);
  if (said && /connection (closed|lost)|not connected/i.test(said)) {
    return new GatewayError(SESSION_DROPPED, 409, false, httpStatus);
  }
  if (httpStatus === 404) return new GatewayError(`A instância não existe no gateway${said ? ` (${said})` : ""}.`, 404, false, httpStatus);
  return new GatewayError(
    `O gateway recusou${said ? `: ${said}` : ""} [HTTP ${httpStatus}].`,
    httpStatus >= 500 || httpStatus < 400 ? 502 : 400,
    false,
    httpStatus,
  );
}

/** Chamada à Evolution com a chave no cabeçalho, tempo limite e o erro traduzido. */
async function call<T = Record<string, unknown>>(
  http: Fetch,
  gw: Gateway,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  opts: CallOpts = {},
): Promise<T> {
  const base = await publicBase(gw.base, opts.resolve);
  const host = new URL(base).host;
  const secrets = [gw.apiKey, ...(opts.secrets ?? [])];
  const headers: Record<string, string> = { apikey: gw.apiKey, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  let text: string;
  try {
    response = await http(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new IntegrationError("O gateway respondeu com um redirecionamento. Informe o endereço final (com https).", 502);
    }
    // O tempo limite vale também para a leitura do corpo.
    text = await readLimited(response);
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    const name = (error as { name?: unknown } | null)?.name;
    throw new IntegrationError(
      name === "TimeoutError" || name === "AbortError"
        ? `O gateway do WhatsApp (${host}) não respondeu a tempo.`
        : `Não consegui falar com o gateway do WhatsApp (${host}). Confira o endereço e se ele está no ar.`,
      502,
    );
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Página de erro de proxy: fica só o status.
  }
  if (!response.ok) throw gatewayError(response.status, parsed, secrets);
  // 200 com HTML (o painel da Evolution, um site qualquer): não é a API, e o envio não aconteceu.
  if (parsed === null) throw new IntegrationError(`O endereço ${host} não respondeu como a Evolution API. Confira o endereço do gateway.`, 502);
  // O connect responde 200 com { error: true, message } quando falha.
  if (record(parsed).error === true) throw gatewayError(400, parsed, secrets);
  return parsed as T;
}

/** Corpo da resposta com limite (sem confiar só no Content-Length: resposta em pedaços não o traz). */
async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const tooBig = () => new IntegrationError("O gateway respondeu grande demais.", 502);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw tooBig();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const path = (action: string, instance: string) => `/${action}/${encodeURIComponent(instance)}`;

/** QR Code como data URL de PNG (a tela põe direto num <img>); qualquer outra coisa vira null. */
export function qrImage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > MAX_QR_CHARS) return null;
  if (PNG_DATA_URL.test(v)) return v;
  if (v.length >= 100 && BARE_BASE64.test(v)) return `data:image/png;base64,${v}`;
  return null;
}

/** Estado da sessão nas respostas da Evolution ({ instance: { state } } ou { instance: { status } }); só os conhecidos. */
function stateOf(body: unknown): string | null {
  const instance = record(record(body).instance);
  const state = instance.state ?? instance.status;
  return typeof state === "string" && STATES.has(state) ? state : null;
}

/** Pede o QR (GET /instance/connect): aberta = conectado; QR novo = aguardando; limite de QR = desconectado. */
async function connectQr(http: Fetch, gw: Gateway, opts: CallOpts): Promise<{ status: WhatsappQrState; qr: string | null }> {
  const body = await call(http, gw, "GET", path("instance/connect", gw.instance), undefined, { ...opts, timeoutMs: SLOW_TIMEOUT_MS });
  if (stateOf(body) === "open") return { status: "conectado", qr: null };
  const qr = qrImage(record(body).base64 ?? record(record(body).qrcode).base64);
  if (qr) return { status: "aguardando_qr", qr };
  // Sem QR: ou ainda está sendo gerado (a tela pergunta de novo), ou passou do limite de QRs.
  return { status: stateOf(body) === "refused" ? "desconectado" : "aguardando_qr", qr: null };
}

/**
 * Cria a instância e devolve o QR que veio junto. Se ela já existe (reconexão) ou a chave é só da
 * instância (fornecedores que não dão a chave global), segue se a instância responde com essa chave.
 */
async function ensureInstance(http: Fetch, gw: Gateway, opts: CallOpts): Promise<string | null> {
  try {
    const created = await call(
      http,
      gw,
      "POST",
      "/instance/create",
      { instanceName: gw.instance, qrcode: true, integration: "WHATSAPP-BAILEYS" },
      { ...opts, timeoutMs: SLOW_TIMEOUT_MS },
    );
    return qrImage(record(record(created).qrcode).base64);
  } catch (error) {
    if (!(error instanceof GatewayError) || ![401, 403].includes(error.httpStatus)) throw error;
    try {
      await call(http, gw, "GET", path("instance/connectionState", gw.instance), undefined, opts);
    } catch {
      throw error;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

export const whatsappQrInput = z.object({
  base_url: z.string().trim().min(1, "Informe o endereço do gateway.").max(500),
  api_key: z
    .string()
    .trim()
    .min(8, "Chave do gateway curta demais.")
    .max(500)
    .regex(/^[\x21-\x7e]+$/, "A chave do gateway não pode ter espaços nem acentos."),
  instance: z
    .string()
    .trim()
    .regex(INSTANCE_NAME, "Nome da instância: 3 a 60 letras, números, - ou _.")
    .optional(),
  label: z.string().trim().min(1).max(60).optional(),
  accept_risks: z.literal(true),
});

function risksRefusal(): IntegrationError {
  return new IntegrationError(
    `Para conectar o WhatsApp por QR Code, confirme que entende os riscos (accept_risks: true):\n- ${WHATSAPP_QR_RISKS.join("\n- ")}`,
    400,
  );
}

export function whatsappQrWebhookUrl(appUrl: string, connectionId: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/channels/whatsapp-qr/${connectionId}/${token}`;
}

/**
 * Situação da sessão em metadata (sem segredo). Pelo webhook: "open" tira o erro da conexão (o
 * webhook está funcionando), "close"/"refused" deixam o aviso para reler o QR.
 */
async function saveState(
  sql: Sql,
  connectionId: string,
  state: string,
  now: Date,
  opts: { fromWebhook?: boolean; number?: string | null } = {},
) {
  const patch: Record<string, unknown> = { state, state_at: now.toISOString() };
  if (opts.number) patch.number = opts.number;
  const recover = Boolean(opts.fromWebhook) && state === "open";
  const dropped = Boolean(opts.fromWebhook) && (state === "close" || state === "refused");
  await sql.query(
    `update integration_connections
        set metadata = metadata || $2::jsonb, updated_at = now(),
            status = case when $3::boolean and status = 'error' then 'active' else status end,
            last_error = case when $3::boolean and status in ('active', 'error') then null when $4::boolean then $5::text else last_error end
      where id = $1 and provider = 'whatsapp_qr'`,
    [connectionId, json(patch), recover, dropped, SESSION_DROPPED],
  );
}

/**
 * Conecta um número pelo gateway: grava a conexão (só o hash do token do webhook), cria a
 * instância, aponta o webhook para o Spherum e devolve o QR para ler no celular. Se o gateway
 * falhar depois de gravar, a conexão fica com status 'error' e o motivo em last_error.
 */
export async function createWhatsappQrConnection(
  deps: IntegrationDeps,
  agencyId: string,
  raw: unknown,
  createdBy: string | null,
  resolve?: Resolver,
): Promise<{ id: string; status: WhatsappQrState; qr: string | null }> {
  if (record(raw).accept_risks !== true) throw risksRefusal();
  const input = whatsappQrInput.parse(raw);
  const base = await publicBase(input.base_url, resolve);
  const instance = input.instance ?? `spherum-${randomBytes(4).toString("hex")}`;
  const token = randomToken();
  const id = await saveConnection(deps, {
    agencyId,
    provider: PROVIDER,
    label: input.label ?? `WhatsApp QR (${instance})`,
    account: `${base}#${instance}`,
    secret: { apiKey: input.api_key, extra: { webhook_token_hash: sha256Hex(token) } },
    metadata: { base_url: base, instance },
    createdBy,
  });
  const gw: Gateway = { base, instance, apiKey: input.api_key };
  const opts: CallOpts = { resolve, secrets: [token] };
  const now = deps.now ? deps.now() : new Date();
  try {
    let qr = await ensureInstance(deps.fetch, gw, opts);
    await call(
      deps.fetch,
      gw,
      "POST",
      path("webhook/set", instance),
      { webhook: { enabled: true, url: whatsappQrWebhookUrl(deps.appUrl, id, token), byEvents: false, base64: false, events: EVENTS } },
      opts,
    );
    let status: WhatsappQrState = "aguardando_qr";
    if (!qr) ({ status, qr } = await connectQr(deps.fetch, gw, opts));
    await saveState(deps.sql, id, status === "conectado" ? "open" : "connecting", now);
    return { id, status, qr };
  } catch (error) {
    const said = error instanceof IntegrationError ? error.message : "Falha inesperada ao configurar o gateway.";
    await deps.sql.query(`update integration_connections set status = 'error', last_error = $2, updated_at = now() where id = $1`, [
      id,
      clip(redact(said, [token, input.api_key]), 500),
    ]);
    if (error instanceof IntegrationError) {
      throw new IntegrationError(`${said} A conexão ficou marcada com erro; corrija e conecte de novo.`, error.status, error.reauth);
    }
    console.warn("[canais] whatsapp-qr: falha ao configurar o gateway", id, error instanceof Error ? error.message : error);
    throw new IntegrationError("Falha inesperada ao configurar o gateway. A conexão ficou marcada com erro.", 502);
  }
}

/** Gateway de uma conexão gravada (metadata + chave cifrada). */
function gatewayOf(row: ConnectionRow, apiKey: string | undefined): Gateway {
  const base = row.metadata.base_url;
  const instance = row.metadata.instance;
  if (typeof base !== "string" || typeof instance !== "string" || !INSTANCE_NAME.test(instance) || !apiKey) {
    throw new ChannelError("A conexão do WhatsApp por QR Code está incompleta. Conecte de novo.", 409);
  }
  return { base, instance, apiKey };
}

/**
 * Situação da sessão para a tela: "open" = conectado; "connecting"/"close" pedem um QR novo ao
 * gateway. Grava o estado em metadata.
 */
export async function whatsappQrStatus(
  deps: IntegrationDeps,
  agencyId: string,
  connectionId: string,
  resolve?: Resolver,
): Promise<{ status: WhatsappQrState; qr: string | null }> {
  const row = await loadConnection(deps.sql, agencyId, connectionId);
  if (row.provider !== PROVIDER || row.status === "revoked") throw new IntegrationError("Conexão não encontrada.", 404);
  let gw: Gateway;
  try {
    gw = gatewayOf(row, (await readSecret(deps, row)).apiKey);
  } catch (error) {
    if (error instanceof ChannelError) throw new IntegrationError(error.message, 409);
    throw error;
  }
  const opts: CallOpts = { resolve };
  const now = deps.now ? deps.now() : new Date();
  const state = stateOf(await call(deps.fetch, gw, "GET", path("instance/connectionState", gw.instance), undefined, opts));
  const result = state === "open" ? { status: "conectado" as const, qr: null } : await connectQr(deps.fetch, gw, opts);
  await saveState(deps.sql, row.id, result.status === "conectado" ? "open" : (state ?? "connecting"), now);
  return result;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/**
 * Ao desconectar no Spherum: desliga o webhook e encerra a sessão no gateway (sem isso a
 * instância continua logada e mandando mensagens para uma URL que não aceita mais nada).
 * Melhor esforço: o gateway fora do ar não impede a desconexão.
 */
export async function disconnectWhatsappQr(deps: IntegrationDeps, agencyId: string, connectionId: string): Promise<void> {
  const a = await access(deps, agencyId, connectionId);
  const gw = gatewayOf(a.connection, a.accessToken);
  await call(deps.fetch, gw, "POST", path("webhook/set", gw.instance), {
    webhook: { enabled: false, url: `${deps.appUrl.replace(/\/+$/, "")}/api/channels/whatsapp-qr/desligado`, events: [] },
  }).catch(() => undefined);
  await call(deps.fetch, gw, "DELETE", path("instance/logout", gw.instance)).catch(() => undefined);
}

export type WhatsappQrHook = { id: string; agencyId: string; instance: string };

/**
 * Confere o token do caminho da URL contra o hash guardado. Conexão inexistente, revogada, token
 * malformado ou errado: tudo vira null (a rota responde o mesmo 401).
 */
export async function authenticateWhatsappQr(deps: IntegrationDeps, connectionId: string, token: string): Promise<WhatsappQrHook | null> {
  if (!UUID.test(connectionId) || !WEBHOOK_TOKEN.test(token)) return null;
  const conn = await channelConnection(deps.sql, connectionId, PROVIDER);
  if (!conn) return null;
  const secret = await readSecret(deps, await loadConnection(deps.sql, conn.agencyId, conn.id));
  const hash = secret.extra?.webhook_token_hash;
  const instance = conn.metadata.instance;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || typeof instance !== "string") return null;
  return safeEqual(sha256Hex(token), hash) ? { id: conn.id, agencyId: conn.agencyId, instance } : null;
}

export type EvolutionEvent =
  | { kind: "message"; instance: string | null; eventId: string; number: string; name: string | null; text: string; sentAt: Date | null }
  | { kind: "connection"; instance: string | null; state: string; number: string | null };

const jid = z.string().max(200);
const textContent = z.object({
  conversation: z.string().nullish(),
  extendedTextMessage: z.object({ text: z.string().nullish() }).nullish(),
});
const textOf = (m: z.infer<typeof textContent> | null | undefined) => (m?.conversation || m?.extendedTextMessage?.text || "").trim();
const upsertSchema = z.object({
  key: z.object({
    remoteJid: jid,
    fromMe: z.boolean(),
    id: z.string().min(1).max(200),
    remoteJidAlt: jid.nullish().catch(null),
    senderPn: jid.nullish().catch(null),
  }),
  // Nome e hora são opcionais: valor estranho neles não derruba a mensagem.
  pushName: z.unknown().optional(),
  // Com mensagens temporárias ligadas, o texto pode vir dentro de ephemeralMessage.message.
  message: textContent.extend({ ephemeralMessage: z.object({ message: textContent.nullish() }).nullish() }).nullish(),
  messageTimestamp: z.unknown().optional(),
});

/** Número de um jid de conversa individual ("5511…@s.whatsapp.net", com ou sem ":aparelho"). */
function numberOf(value: string | null | undefined): string | null {
  const m = value?.trim().match(/^(\d{5,20})(?::\d{1,3})?@(?:s\.whatsapp\.net|c\.us)$/);
  return m ? m[1] : null;
}

/** Quem mandou. Grupos, status, canais e transmissões não; LID só com o número ao lado. */
function senderOf(key: z.infer<typeof upsertSchema>["key"]): string | null {
  const remote = key.remoteJid.trim();
  if (remote.endsWith("@lid")) return numberOf(key.remoteJidAlt) ?? numberOf(key.senderPn);
  return numberOf(remote);
}

function timeOf(value: unknown): Date | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d{1,13}$/.test(value))) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}

/**
 * Traduz o webhook da Evolution: "messages.upsert" (ou "MESSAGES_UPSERT"; data como objeto ou
 * lista) vira mensagens de texto de conversas individuais; "connection.update" vira o estado da
 * sessão. O resto (nossas mensagens, grupos, status, mídia sem texto, malformados) fica de fora.
 */
export function parseEvolutionWebhook(body: unknown): EvolutionEvent[] {
  const b = record(body);
  const event = typeof b.event === "string" ? b.event.trim().toLowerCase().replace(/_/g, ".") : "";
  const instance = typeof b.instance === "string" ? b.instance : null;
  const items = (Array.isArray(b.data) ? b.data : [b.data]).slice(0, MAX_ITEMS);
  if (event === "messages.upsert") {
    const out: EvolutionEvent[] = [];
    for (const item of items) {
      const parsed = upsertSchema.safeParse(item);
      if (!parsed.success || parsed.data.key.fromMe) continue;
      const { key, pushName, message, messageTimestamp } = parsed.data;
      const number = senderOf(key);
      if (!number) continue;
      const text = textOf(message) || textOf(message?.ephemeralMessage?.message);
      if (!text) continue;
      // O nome do perfil é escolhido pela pessoa: sem quebras de linha nem caracteres de controle.
      const name = typeof pushName === "string" ? pushName.replace(/\p{Cc}+/gu, " ").trim() : null;
      out.push({ kind: "message", instance, eventId: key.id, number, name: name ? clip(name, 100) : null, text, sentAt: timeOf(messageTimestamp) });
    }
    return out;
  }
  if (event === "connection.update") {
    const data = record(items[0]);
    const state = typeof data.state === "string" ? data.state : "";
    if (!STATES.has(state)) return [];
    return [{ kind: "connection", instance, state, number: numberOf(typeof data.wuid === "string" ? data.wuid : null) }];
  }
  return [];
}

export type WhatsappQrResult = InboundResult & { eventId: string };

/**
 * Processa um webhook já autenticado: texto vai para o núcleo (pareamento, "aprovar"/"negar",
 * conversa); a mudança de sessão atualiza a conexão.
 */
export async function handleWhatsappQr(
  deps: ChannelDeps,
  adapters: Adapters,
  hook: WhatsappQrHook,
  payload: unknown,
): Promise<{ messages: WhatsappQrResult[]; state: string | null }> {
  const now = deps.now ? deps.now() : new Date();
  const messages: WhatsappQrResult[] = [];
  let state: string | null = null;
  for (const event of parseEvolutionWebhook(payload)) {
    // Outra instância do mesmo gateway: não é desta conexão.
    if (event.instance !== null && event.instance !== hook.instance) continue;
    try {
      if (event.kind === "connection") {
        await saveState(deps.sql, hook.id, event.state, now, { fromWebhook: true, number: event.number });
        state = event.state;
        continue;
      }
      if (event.sentAt && now.getTime() - event.sentAt.getTime() > STALE_MS) {
        messages.push({ eventId: event.eventId, status: "ignored", detail: "antiga" });
        continue;
      }
      const msg: InboundMessage = {
        provider: PROVIDER,
        connectionId: hook.id,
        agencyId: hook.agencyId,
        eventId: event.eventId,
        externalUser: event.number,
        displayName: event.name,
        conversationKey: event.number,
        text: event.text,
        reply: { number: event.number },
        direct: true,
      };
      messages.push({ eventId: event.eventId, ...(await receiveMessage(deps, adapters, msg)) });
    } catch (error) {
      console.warn("[canais] whatsapp-qr: evento falhou", hook.id, error instanceof Error ? error.message : error);
      if (event.kind === "message") messages.push({ eventId: event.eventId, status: "failed" });
    }
  }
  return { messages, state };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

const targetSchema = z.object({ number: z.string().regex(NUMBER) });

/** Markdown do xodó no formato do WhatsApp: títulos e **negrito** viram *negrito*; links por extenso. */
export function toWhatsappText(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+(.+)$/gm, (_, title: string) => `*${title.replace(/\*+/g, "").trim()}*`)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
}

/**
 * Sem botões garantidos: como decidir por texto (o núcleo entende "aprovar", "negar 2"…). Com mais
 * de um pedido pendente na conversa, sempre com o número, porque "aprovar" sozinho fica ambíguo.
 */
export function approvalInstructions(approvals: OutboundApproval[], pending = approvals.length): string {
  if (!approvals.length) return "";
  if (approvals.length === 1 && pending <= 1) return "Responda *aprovar* ou *negar*.";
  const lines = approvals.map((a) => {
    const summary = clip(a.summary.replace(/\s+/g, " ").trim() || "pedido", 80);
    return `• *aprovar ${a.index}* ou *negar ${a.index}*: ${summary}`;
  });
  return ["Para decidir, responda com o número do pedido:", ...lines].join("\n");
}

/**
 * O número de cada pedido já vem da fila (o número fixo da conversa, o mesmo que "aprovar N"
 * entende). Aqui só conta quantos estão pendentes, para saber se "aprovar" sozinho basta.
 */
async function numberApprovals(ctx: SendContext, number: string, approvals: OutboundApproval[]) {
  if (!approvals.length) return { approvals, pending: 0 };
  const pending = await pendingInThread(ctx.deps.sql, ctx.access.connection.id, number, ctx.access.connection.agency_id);
  return { approvals: approvals.filter((a) => pending.includes(a.actionId)), pending: pending.length };
}

const MAX_CHARS = 4096;

export const whatsappQrAdapter: ChannelAdapter = {
  provider: PROVIDER,
  maxChars: MAX_CHARS,
  async send(ctx, message) {
    const target = targetSchema.safeParse(ctx.target);
    if (!target.success) throw new ChannelError("A conversa não tem o número do WhatsApp para responder.");
    const gw = gatewayOf(ctx.access.connection, ctx.access.accessToken);
    const text = toWhatsappText(message.text.trim());
    const { approvals, pending } = await numberApprovals(ctx, target.data.number, message.approvals);
    const extra = approvalInstructions(approvals, pending);
    // As instruções vão junto do último pedaço; se não couberem, numa mensagem logo depois.
    const parts = !extra ? [text] : !text ? [extra] : text.length + extra.length + 2 <= MAX_CHARS ? [`${text}\n\n${extra}`] : [text, extra];
    for (const part of parts) {
      if (!part) continue;
      try {
        await call(ctx.deps.fetch, gw, "POST", path("message/sendText", gw.instance), { number: target.data.number, text: part });
      } catch (error) {
        // Chave recusada: marca a conexão, para o app pedir a reconexão em vez de tentar para sempre.
        if (error instanceof GatewayError && error.httpStatus === 401) {
          await ctx.deps.sql.query(`update integration_connections set status = 'expired', last_error = $2, updated_at = now() where id = $1`, [
            ctx.access.connection.id,
            error.message,
          ]);
        }
        throw error;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Grupos (Prospecção): os grupos em que o número está e quem participa de cada um
// ---------------------------------------------------------------------------

async function qrGateway(deps: IntegrationDeps, agencyId: string, connectionId: string): Promise<Gateway> {
  const row = await loadConnection(deps.sql, agencyId, connectionId);
  if (row.provider !== PROVIDER || row.status !== "active") throw new IntegrationError("Conexão do WhatsApp por QR Code não encontrada ou desligada.", 404);
  try {
    return gatewayOf(row, (await readSecret(deps, row)).apiKey);
  } catch (error) {
    if (error instanceof ChannelError) throw new IntegrationError(error.message, 409);
    throw error;
  }
}

export type WhatsappGroup = { id: string; name: string; size: number | null };

/** Grupos do número conectado (GET /group/fetchAllGroups, sem os participantes, que pesa). */
export async function whatsappQrGroups(deps: IntegrationDeps, agencyId: string, connectionId: string, resolve?: Resolver): Promise<WhatsappGroup[]> {
  const gw = await qrGateway(deps, agencyId, connectionId);
  const body = await call<unknown>(deps.fetch, gw, "GET", `${path("group/fetchAllGroups", gw.instance)}?getParticipants=false`, undefined, { resolve, timeoutMs: SLOW_TIMEOUT_MS });
  const list = Array.isArray(body) ? body : [];
  return list
    .map((g) => record(g))
    .filter((g) => typeof g.id === "string" && g.id.endsWith("@g.us"))
    .map((g) => ({ id: g.id as string, name: clip(String(g.subject ?? "Grupo sem nome"), 100), size: typeof g.size === "number" ? g.size : null }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/**
 * Telefones de quem está no grupo. O WhatsApp esconde o número de parte dos participantes
 * (ids "@lid"); esses só entram quando o gateway devolve o número junto (phoneNumber).
 */
export async function whatsappQrGroupMembers(
  deps: IntegrationDeps,
  agencyId: string,
  connectionId: string,
  groupId: string,
  resolve?: Resolver,
): Promise<{ phones: string[]; hidden: number }> {
  if (!/^[\d-]{5,40}@g\.us$/.test(groupId)) throw new IntegrationError("Grupo inválido.", 400);
  const gw = await qrGateway(deps, agencyId, connectionId);
  const body = record(
    await call<unknown>(deps.fetch, gw, "GET", `${path("group/participants", gw.instance)}?groupJid=${encodeURIComponent(groupId)}`, undefined, { resolve, timeoutMs: SLOW_TIMEOUT_MS }),
  );
  const list = Array.isArray(body.participants) ? body.participants : [];
  const phones: string[] = [];
  let hidden = 0;
  for (const p of list.map(record)) {
    const jid = [p.phoneNumber, p.jid, p.id].find((v) => typeof v === "string" && /@s\.whatsapp\.net$/.test(v)) as string | undefined;
    if (!jid) { hidden++; continue; }
    phones.push(jid.split("@")[0]);
  }
  return { phones, hidden };
}
