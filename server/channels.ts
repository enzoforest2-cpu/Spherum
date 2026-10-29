import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { metaGraph } from "../src/integrations/oauth-providers";
import { readSecret, saveConnection, type ConnectionRow, type IntegrationDeps } from "../src/integrations/store";
import { decideAction } from "../src/xodos/actions";
import { json, one, parseJson } from "../src/xodos/db";
import { XodoError } from "../src/xodos/errors";
import { loadXodo, startRun, type EngineDeps } from "../src/xodos/runner";
import type { AppState } from "./state";
import type { Worker } from "./worker";

/**
 * Os xodós no Telegram e no WhatsApp.
 *
 * Telegram: você cria um bot no @BotFather e cola o token. O app pergunta ao Telegram por
 * mensagens novas (long polling), então funciona no computador sem endereço público. Para o
 * bot só atender você, o vínculo é por código: o app mostra um código e você manda ao bot.
 *
 * WhatsApp: API oficial da Meta (WhatsApp Cloud). Você cadastra o ID do número e o token;
 * o xodó manda mensagens para o seu número. Para receber, a Meta chama /webhook/whatsapp, que
 * precisa estar num endereço público (no Spherum já está; no computador, por um túnel).
 *
 * Nos dois, o que o xodó escreve na conversa entra na fila do motor (channel_outbox) e sai
 * daqui, com os pedidos de aprovação ("aprovar 3"), e os avisos do sino também são repassados.
 */

type Channel = "telegram" | "whatsapp";
type Ctx = { deps: EngineDeps; state: AppState; worker: Worker };

const PROVIDER_CHANNEL: Record<string, Channel> = { telegram: "telegram", whatsapp_cloud: "whatsapp" };
const CHANNEL_LABEL: Record<Channel, string> = { telegram: "Telegram", whatsapp: "WhatsApp" };
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const PART_MAX = 3800;
const DECISION = /^\s*(aprovar|aprovo|sim|pode|ok|negar|nego|não|nao)\s*#?\s*(\d{1,4})\s*[.!]?\s*$/i;

// ---------------------------------------------------------------------------
// Pequenas peças
// ---------------------------------------------------------------------------

const digits = (s: string) => s.replace(/\D+/g, "");

/** A Meta às vezes manda celulares do Brasil sem o 9 (55 41 9xxxx-xxxx vira 55 41 xxxx-xxxx). */
export function sameWhatsNumber(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  if (x === y) return true;
  const drop9 = (n: string) => (n.length === 13 && n.startsWith("55") && n[4] === "9" ? n.slice(0, 4) + n.slice(5) : n);
  return drop9(x) === drop9(y);
}

/** Corta em pedaços que cabem numa mensagem, preferindo quebrar entre parágrafos. */
export function splitParts(text: string, max = PART_MAX): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const codeHash = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

class ChannelError extends XodoError {}

// ---------------------------------------------------------------------------
// Telegram e WhatsApp: só o envio e a leitura, sem regra nenhuma
// ---------------------------------------------------------------------------

async function telegram<T>(http: typeof fetch, token: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await http(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError" && signal?.aborted) throw error;
    throw new ChannelError("Não consegui falar com o Telegram. Confira a internet.", 502);
  }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
  if (!data.ok) {
    const status = data.error_code === 401 || data.error_code === 404 ? 401 : (data.error_code ?? res.status);
    throw new ChannelError(status === 401 ? "O Telegram recusou o token do bot. Confira no @BotFather." : `Telegram: ${data.description ?? res.status}`, status);
  }
  return data.result as T;
}

async function whatsapp<T>(http: typeof fetch, token: string, pathAndQuery: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await http(`${metaGraph()}/${pathAndQuery}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ChannelError("Não consegui falar com a Meta. Confira a internet.", 502);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (!res.ok || data.error) {
    const code = data.error?.code;
    if (code === 190 || res.status === 401) throw new ChannelError("A Meta recusou o token do WhatsApp. Gere outro no painel do app da Meta.", 401);
    // Fora da janela de 24 h a Meta só aceita modelos aprovados.
    if (code === 131047 || code === 131026) {
      throw new ChannelError("A Meta só deixa o xodó escrever até 24 h depois da sua última mensagem. Mande um \"oi\" para o número do xodó no WhatsApp e tente de novo.", 409);
    }
    throw new ChannelError(`WhatsApp: ${data.error?.message ?? res.status}`, res.status >= 400 && res.status < 500 ? 400 : 502);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Entradas da tela
// ---------------------------------------------------------------------------

const telegramInput = z.object({
  token: z.string().trim().regex(/^\d{5,}:[\w-]{30,}$/, "o token do @BotFather é parecido com 123456789:ABCdef..."),
  xodo_id: z.uuid(),
});

const whatsappInput = z.object({
  phone_number_id: z.string().trim().regex(/^\d{8,20}$/, "o ID do número (Phone number ID) só tem números"),
  token: z.string().trim().min(20).max(1000),
  app_secret: z.string().trim().max(200).optional().default(""),
  meu_numero: z
    .string()
    .trim()
    .transform(digits)
    .refine((n) => n.length >= 10 && n.length <= 15, "escreva seu número com DDI e DDD, ex.: 55 41 99999-8888"),
  xodo_id: z.uuid(),
});

const channelPatch = z.object({ xodo_id: z.uuid().optional(), avisos: z.boolean().optional() });

// ---------------------------------------------------------------------------
// O canal
// ---------------------------------------------------------------------------

type Inbound = {
  conn: ConnectionRow;
  channel: Channel;
  externalUser: string;
  /** Telegram: id do chat; WhatsApp: número de quem escreveu. */
  chatKey: string;
  name: string;
  text: string;
};

export class Channels {
  private polls = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  // Só escuta e entrega depois de start() (os testes chamam as partes direto).
  private stopped = true;

  constructor(private ctx: Ctx) {}

  private get integ(): IntegrationDeps {
    const i = this.ctx.deps.integrations;
    if (!i) throw new XodoError("Integrações desligadas.", 503);
    return { ...i, sql: this.ctx.deps.sql, now: this.ctx.deps.now };
  }
  private get sql() {
    return this.ctx.deps.sql;
  }
  private get owner() {
    return this.ctx.state.ownerId;
  }

  start() {
    this.stopped = false;
    // Entregas que estavam saindo quando o app fechou voltam para a fila.
    void this.sql.query(`update channel_outbox set status = 'pending' where status = 'sending'`).catch(() => {});
    void this.refresh();
    this.timer = setInterval(() => void this.pump(), 2000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.polls.values()) c.abort();
    this.polls.clear();
  }

  /** Liga a escuta de cada bot do Telegram ativo (e desliga a dos que saíram). */
  async refresh() {
    if (this.stopped) return;
    const rows = await this.sql.query<ConnectionRow>(
      `select * from integration_connections where agency_id = $1 and provider = 'telegram' and status = 'active'`,
      [this.owner],
    );
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, c] of this.polls) {
      if (!ids.has(id)) {
        c.abort();
        this.polls.delete(id);
      }
    }
    for (const row of rows) if (!this.polls.has(row.id)) this.pollTelegram(row);
  }

  // ---- Lista e cadastro (rotas da tela)

  async list() {
    const rows = await this.sql.query<ConnectionRow & { created_at: string; last_error: string | null }>(
      `select id, provider, label, external_account, status, metadata, last_error, created_at::text from integration_connections
        where agency_id = $1 and provider in ('telegram', 'whatsapp_cloud') and status <> 'revoked' order by created_at`,
      [this.owner],
    );
    const out = [];
    for (const r of rows) {
      const channel = PROVIDER_CHANNEL[r.provider];
      const meta = (parseJson<Record<string, unknown>>(r.metadata) ?? {}) as Record<string, unknown>;
      const xodo = await one<{ xodo_id: string }>(this.sql, `select xodo_id from xodo_channels where connection_id = $1 and enabled order by created_at limit 1`, [r.id]);
      const who = await one<{ display_name: string | null; external_user: string }>(
        this.sql,
        `select display_name, external_user from channel_identities where agency_id = $1 and provider = $2 order by created_at desc limit 1`,
        [this.owner, channel],
      );
      out.push({
        id: r.id,
        canal: channel,
        nome: r.label,
        status: r.status,
        erro: r.last_error,
        xodo_id: xodo?.xodo_id ?? null,
        avisos: meta.avisos !== false,
        vinculado: who ? who.display_name || who.external_user : null,
        usuario_bot: meta.username ?? null,
        numero: meta.display_phone_number ?? null,
        meu_numero: meta.owner_number ?? null,
        verify_token: channel === "whatsapp" ? meta.verify_token : undefined,
        criado_em: r.created_at,
      });
    }
    return out;
  }

  async connectTelegram(body: unknown) {
    const input = telegramInput.parse(body);
    await loadXodo(this.sql, input.xodo_id, this.owner);
    const bot = await telegram<{ id: number; username: string; first_name: string }>(this.integ.fetch, input.token, "getMe", {});
    // O bot pode ter um webhook de outro sistema; com ele ligado, o Telegram não entrega por aqui.
    await telegram(this.integ.fetch, input.token, "deleteWebhook", { drop_pending_updates: false }).catch(() => {});
    const id = await saveConnection(this.integ, {
      agencyId: this.owner,
      provider: "telegram",
      label: `@${bot.username}`,
      account: String(bot.id),
      secret: { apiKey: input.token },
      metadata: { username: bot.username, avisos: true },
      createdBy: this.ctx.state.userId,
    });
    await this.assign(id, input.xodo_id);
    await this.refresh();
    return { id, ...(await this.pairingCode(id)) };
  }

  async connectWhatsapp(body: unknown) {
    const input = whatsappInput.parse(body);
    await loadXodo(this.sql, input.xodo_id, this.owner);
    const info = await whatsapp<{ display_phone_number?: string; verified_name?: string }>(
      this.integ.fetch,
      input.token,
      `${input.phone_number_id}?fields=display_phone_number,verified_name`,
    );
    const existing = await one<{ metadata: unknown }>(
      this.sql,
      `select metadata from integration_connections where agency_id = $1 and provider = 'whatsapp_cloud' and external_account = $2 and status <> 'revoked'`,
      [this.owner, input.phone_number_id],
    );
    const verifyToken = (parseJson<{ verify_token?: string }>(existing?.metadata)?.verify_token as string | undefined) ?? randomBytes(18).toString("base64url");
    const id = await saveConnection(this.integ, {
      agencyId: this.owner,
      provider: "whatsapp_cloud",
      label: info.verified_name ? `${info.verified_name} (${info.display_phone_number ?? input.phone_number_id})` : (info.display_phone_number ?? input.phone_number_id),
      account: input.phone_number_id,
      secret: { apiKey: input.token, extra: { appSecret: input.app_secret || null } },
      metadata: { display_phone_number: info.display_phone_number ?? null, owner_number: input.meu_numero, verify_token: verifyToken, avisos: true },
      createdBy: this.ctx.state.userId,
    });
    await this.assign(id, input.xodo_id);
    // Você mesmo cadastrou o seu número: ele já vale como vínculo (não precisa de código).
    await this.sql.query(
      `insert into channel_identities (agency_id, provider, external_user, user_id, display_name) values ($1, 'whatsapp', $2, $3, $4)
       on conflict (agency_id, provider, external_user) do update set user_id = excluded.user_id`,
      [this.owner, input.meu_numero, this.ctx.state.userId, this.ctx.state.settings.nome || null],
    );
    return { id };
  }

  async update(connectionId: string, body: unknown) {
    const patch = channelPatch.parse(body);
    const conn = await this.connection(connectionId);
    if (patch.xodo_id) {
      await loadXodo(this.sql, patch.xodo_id, this.owner);
      await this.assign(conn.id, patch.xodo_id);
    }
    if (patch.avisos !== undefined) {
      await this.sql.query(`update integration_connections set metadata = metadata || $2::jsonb, updated_at = now() where id = $1`, [
        conn.id,
        json({ avisos: patch.avisos }),
      ]);
    }
  }

  /** Código de vínculo do Telegram (uso único, 10 minutos). */
  async pairingCode(connectionId: string) {
    const conn = await this.connection(connectionId);
    if (conn.provider !== "telegram") throw new XodoError("No WhatsApp o vínculo é pelo seu número.", 400);
    const code = newCode();
    const now = this.integ.now?.() ?? new Date();
    await this.sql.query(`delete from channel_pairing_codes where agency_id = $1 and user_id = $2`, [this.owner, this.ctx.state.userId]);
    await this.sql.query(`insert into channel_pairing_codes (code_hash, agency_id, user_id, expires_at) values ($1, $2, $3, $4::timestamptz)`, [
      codeHash(code),
      this.owner,
      this.ctx.state.userId,
      new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    ]);
    const username = (parseJson<{ username?: string }>(conn.metadata) as { username?: string })?.username;
    return { codigo: code, link: username ? `https://t.me/${username}?start=${code}` : null };
  }

  /** Mensagem de teste para você, no canal. */
  async test(connectionId: string) {
    const conn = await this.connection(connectionId);
    const to = await this.ownerChat(conn);
    if (!to) {
      throw new XodoError(conn.provider === "telegram" ? "Vincule seu Telegram primeiro: mande o código para o bot." : "Cadastre o seu número primeiro.", 409);
    }
    const xodo = await one<{ name: string }>(this.sql, `select x.name from xodo_channels c join xodos x on x.id = c.xodo_id where c.connection_id = $1 limit 1`, [conn.id]);
    await this.sendText(conn, to, `Oi! Aqui é ${xodo?.name ?? "o seu xodó"}. Está tudo certo: pode falar comigo por aqui.`);
  }

  // ---- Ligações

  private async connection(connectionId: string): Promise<ConnectionRow> {
    const row = await one<ConnectionRow>(
      this.sql,
      `select * from integration_connections where id = $1 and agency_id = $2 and provider in ('telegram', 'whatsapp_cloud') and status <> 'revoked'`,
      [connectionId, this.owner],
    );
    if (!row) throw new XodoError("Canal não encontrado.", 404);
    return row;
  }

  /** Um xodó atende por canal: trocar aqui troca quem responde. */
  private async assign(connectionId: string, xodoId: string) {
    await this.sql.transaction(async (tx) => {
      await tx.query(`delete from xodo_channels where connection_id = $1 and xodo_id <> $2`, [connectionId, xodoId]);
      await tx.query(
        `insert into xodo_channels (agency_id, xodo_id, connection_id, scope) values ($1, $2, $3, '*')
         on conflict (connection_id, scope, xodo_id) do update set enabled = true`,
        [this.owner, xodoId, connectionId],
      );
    });
  }

  /** Para onde mandar algo a você: o chat do Telegram vinculado ou o seu número. */
  private async ownerChat(conn: ConnectionRow): Promise<string | null> {
    const channel = PROVIDER_CHANNEL[conn.provider];
    if (channel === "whatsapp") {
      // Se você já escreveu, responde para o número exatamente como a Meta mandou.
      const conv = await one<{ external_key: string }>(
        this.sql,
        `select external_key from xodo_conversations where connection_id = $1 order by last_message_at desc limit 1`,
        [conn.id],
      );
      return conv?.external_key ?? ((parseJson<{ owner_number?: string }>(conn.metadata) as { owner_number?: string })?.owner_number ?? null);
    }
    const who = await one<{ external_user: string }>(
      this.sql,
      `select external_user from channel_identities where agency_id = $1 and provider = 'telegram' order by created_at desc limit 1`,
      [this.owner],
    );
    // No privado do Telegram, o id do chat é o mesmo da pessoa.
    return who?.external_user ?? null;
  }

  // ---- Telegram: escuta

  private pollTelegram(row: ConnectionRow) {
    const ctl = new AbortController();
    this.polls.set(row.id, ctl);
    void (async () => {
      let offset = Number((parseJson<{ offset?: number }>(row.metadata) as { offset?: number })?.offset ?? 0);
      let token: string;
      try {
        token = (await readSecret(this.integ, row)).apiKey ?? "";
      } catch (error) {
        console.error("[telegram] não consegui abrir o token", row.label, error);
        return;
      }
      while (!ctl.signal.aborted && !this.stopped) {
        try {
          const updates = await telegram<TelegramUpdate[]>(
            this.integ.fetch,
            token,
            "getUpdates",
            { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
            AbortSignal.any([ctl.signal, AbortSignal.timeout(40_000)]),
          );
          for (const u of updates) {
            offset = u.update_id + 1;
            await this.onTelegram(row, token, u).catch((error) => console.error("[telegram] mensagem não tratada", error));
          }
          if (updates.length) {
            await this.sql.query(`update integration_connections set metadata = metadata || $2::jsonb, last_error = null where id = $1`, [row.id, json({ offset })]);
          }
        } catch (error) {
          if (ctl.signal.aborted) return;
          if (error instanceof ChannelError && error.status === 401) {
            await this.sql.query(`update integration_connections set status = 'error', last_error = $2, updated_at = now() where id = $1`, [row.id, error.message]);
            this.polls.delete(row.id);
            return;
          }
          if (error instanceof ChannelError && error.status === 409) {
            // Outro programa usa o mesmo bot (ou um webhook voltou). Tenta tirar o webhook e espera.
            await telegram(this.integ.fetch, token, "deleteWebhook", {}).catch(() => {});
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  private async onTelegram(conn: ConnectionRow, token: string, u: TelegramUpdate) {
    if (u.callback_query) {
      const q = u.callback_query;
      const [verb, actionId] = String(q.data ?? "").split(":");
      let answer = "";
      try {
        answer = await this.decideById(conn, "telegram", String(q.from.id), actionId, verb === "ok");
      } catch (error) {
        answer = error instanceof XodoError ? error.message : "Não consegui registrar.";
      }
      await telegram(this.integ.fetch, token, "answerCallbackQuery", { callback_query_id: q.id, text: answer.slice(0, 190) }).catch(() => {});
      if (q.message) {
        await telegram(this.integ.fetch, token, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await this.sendText(conn, String(q.message.chat.id), answer).catch(() => {});
      }
      return;
    }
    const m = u.message;
    if (!m?.text || !m.from || m.chat.type !== "private") return;
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "Você";
    await this.inbound({ conn, channel: "telegram", externalUser: String(m.from.id), chatKey: String(m.chat.id), name, text: m.text });
  }

  // ---- WhatsApp: webhook da Meta

  /** GET /webhook/whatsapp: a Meta confere o endereço com o token de verificação. */
  async whatsappVerify(query: URLSearchParams): Promise<string | null> {
    if (query.get("hub.mode") !== "subscribe") return null;
    const given = query.get("hub.verify_token") ?? "";
    const row = await one(
      this.sql,
      `select 1 from integration_connections where provider = 'whatsapp_cloud' and status = 'active' and metadata->>'verify_token' = $1`,
      [given],
    );
    return row && given ? (query.get("hub.challenge") ?? "") : null;
  }

  /** POST /webhook/whatsapp: mensagens novas. Só vale com a assinatura da Meta (chave secreta do app). */
  async whatsappWebhook(raw: Buffer, signature: string | undefined): Promise<number> {
    let body: WhatsappWebhook;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return 400;
    }
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value;
        const phoneId = v?.metadata?.phone_number_id;
        if (!phoneId || !v?.messages?.length) continue;
        const conn = await one<ConnectionRow>(
          this.sql,
          `select * from integration_connections where provider = 'whatsapp_cloud' and external_account = $1 and status = 'active'`,
          [phoneId],
        );
        if (!conn) continue;
        const secret = await readSecret(this.integ, conn);
        const appSecret = (secret.extra as { appSecret?: string } | undefined)?.appSecret;
        if (!appSecret || !validSignature(raw, signature, appSecret)) return 401;
        for (const msg of v.messages) {
          const fresh = await one(this.sql, `insert into channel_events (source, event_id) values ('whatsapp', $1) on conflict do nothing returning 1`, [msg.id]);
          if (!fresh) continue;
          const text = msg.type === "text" ? msg.text?.body : msg.type === "button" ? msg.button?.text : msg.interactive?.button_reply?.title;
          if (!text) continue;
          const name = v.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name ?? msg.from;
          await this.inbound({ conn, channel: "whatsapp", externalUser: msg.from, chatKey: msg.from, name, text }).catch((error) =>
            console.error("[whatsapp] mensagem não tratada", error),
          );
        }
      }
    }
    return 200;
  }

  // ---- Comum: quem é, qual conversa, pedido ou decisão

  private async identity(channel: Channel, externalUser: string) {
    const rows = await this.sql.query<{ user_id: string; external_user: string }>(
      `select user_id, external_user from channel_identities where agency_id = $1 and provider = $2`,
      [this.owner, channel],
    );
    return rows.find((r) => (channel === "whatsapp" ? sameWhatsNumber(r.external_user, externalUser) : r.external_user === externalUser)) ?? null;
  }

  private async inbound(m: Inbound) {
    const reply = (text: string) => this.sendText(m.conn, m.chatKey, text).catch((e) => console.warn("[canais] resposta não enviada", e));
    const who = await this.identity(m.channel, m.externalUser);
    if (!who && m.channel === "telegram") {
      const code = m.text.replace(/^\/start\s*/i, "").trim();
      if (code && (await this.pair(m, code))) {
        await reply(`Pronto, ${m.name}! Agora é só falar comigo por aqui.`);
        this.ctx.worker.onChange("*");
        return;
      }
    }
    if (!who) {
      await reply("Oi! Eu sou um xodó particular. Para conversar comigo, abra os Xodós no computador, vá em Integrações e mande aqui o código do Telegram.");
      return;
    }
    const assigned = await one<{ xodo_id: string }>(this.sql, `select xodo_id from xodo_channels where connection_id = $1 and enabled order by created_at limit 1`, [m.conn.id]);
    if (!assigned) {
      await reply("Nenhum xodó atende por aqui ainda. Escolha um em Integrações, no app.");
      return;
    }
    const conv = await one<{ id: string }>(
      this.sql,
      `insert into xodo_conversations (agency_id, xodo_id, channel, connection_id, external_key, title, metadata)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (xodo_id, connection_id, external_key) do update set title = excluded.title
       returning id`,
      [this.owner, assigned.xodo_id, m.channel, m.conn.id, m.chatKey, `${m.name} pelo ${CHANNEL_LABEL[m.channel]}`, json({ chat: m.chatKey })],
    );

    const decision = DECISION.exec(m.text);
    if (decision) {
      const approve = !/^(negar|nego|não|nao)$/i.test(decision[1]);
      const action = await one<{ id: string }>(
        this.sql,
        `select a.id from xodo_actions a join xodo_runs r on r.id = a.run_id
          where r.conversation_id = $1 and a.channel_seq = $2 and a.status = 'pending'`,
        [conv!.id, Number(decision[2])],
      );
      if (action) {
        try {
          await reply(await this.decideById(m.conn, m.channel, m.externalUser, action.id, approve));
        } catch (error) {
          await reply(error instanceof XodoError ? error.message : "Não consegui registrar a decisão.");
        }
        return;
      }
    }

    try {
      const runId = await startRun(this.ctx.deps, {
        xodoId: assigned.xodo_id,
        agencyId: this.owner,
        trigger: "channel",
        text: m.text.slice(0, 8000),
        userId: who.user_id,
        conversationId: conv!.id,
        authorLabel: `${m.name} pelo ${CHANNEL_LABEL[m.channel]}`,
      });
      this.ctx.worker.onChange(runId);
      void this.ctx.worker.drive(runId);
    } catch (error) {
      await reply(error instanceof XodoError ? error.message : "Algo deu errado aqui. Tente de novo daqui a pouco.");
    }
  }

  private async pair(m: Inbound, code: string): Promise<boolean> {
    const now = this.integ.now?.() ?? new Date();
    const row = await one<{ user_id: string }>(
      this.sql,
      `delete from channel_pairing_codes where code_hash = $1 and agency_id = $2 and expires_at > $3::timestamptz returning user_id`,
      [codeHash(code), this.owner, now.toISOString()],
    );
    if (!row) return false;
    await this.sql.query(
      `insert into channel_identities (agency_id, provider, external_user, user_id, display_name) values ($1, $2, $3, $4, $5)
       on conflict (agency_id, provider, external_user) do update set user_id = excluded.user_id, display_name = excluded.display_name`,
      [this.owner, m.channel, m.externalUser, row.user_id, m.name],
    );
    return true;
  }

  private async decideById(conn: ConnectionRow, channel: Channel, externalUser: string, actionId: string, approve: boolean): Promise<string> {
    const who = await this.identity(channel, externalUser);
    if (!who) throw new XodoError("Você ainda não vinculou este chat aos Xodós.", 403);
    if (!z.uuid().safeParse(actionId).success) throw new XodoError("Pedido não encontrado.", 404);
    // Só pedidos das conversas deste canal: um botão antigo de outro bot não decide nada aqui.
    const mine = await one(
      this.sql,
      `select 1 from xodo_actions a join xodo_runs r on r.id = a.run_id join xodo_conversations c on c.id = r.conversation_id
        where a.id = $1 and c.connection_id = $2`,
      [actionId, conn.id],
    );
    if (!mine) throw new XodoError("Pedido não encontrado.", 404);
    const result = await decideAction(this.ctx.deps, { actionId, agencyId: this.owner, userId: who.user_id, approve, via: channel });
    void this.ctx.worker.afterDecision(result.runId);
    this.ctx.worker.onChange(result.runId);
    return approve ? "Aprovado. Sigo daqui." : "Negado. Sigo sem isso.";
  }

  // ---- Saída: fila do motor e avisos do sino

  /** Entrega o que estiver na fila e repassa os avisos novos. Roda a cada 2 s. */
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.deliver();
      await this.forwardNotices();
    } catch (error) {
      console.error("[canais] entrega falhou", error);
    } finally {
      this.busy = false;
    }
  }

  private async deliver() {
    const rows = await this.sql.query<{ id: number; text: string; approvals: unknown; attempts: number; external_key: string; connection_id: string }>(
      `update channel_outbox o set status = 'sending'
         from xodo_conversations c
        where o.id in (
          select o2.id from channel_outbox o2 join xodo_conversations c2 on c2.id = o2.conversation_id
           where o2.status = 'pending' and o2.next_attempt_at <= now() and c2.channel in ('telegram', 'whatsapp') and c2.agency_id = $1
             and not exists (select 1 from channel_outbox p where p.conversation_id = o2.conversation_id and p.id < o2.id and p.status in ('pending', 'sending'))
           order by o2.id limit 10)
          and c.id = o.conversation_id
       returning o.id, o.text, o.approvals, o.attempts, c.external_key, c.connection_id`,
      [this.owner],
    );
    for (const row of rows) {
      try {
        const conn = await one<ConnectionRow>(this.sql, `select * from integration_connections where id = $1 and status = 'active'`, [row.connection_id]);
        if (!conn) throw new ChannelError("O canal foi desconectado.", 410);
        const approvals = (parseJson<{ action_id: string; summary: string }[]>(row.approvals) ?? []) as { action_id: string; summary: string }[];
        await this.sendText(conn, row.external_key, row.text, await this.buttons(approvals));
        await this.sql.query(`update channel_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, error = null where id = $1`, [row.id]);
      } catch (error) {
        const attempts = row.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS || (error instanceof ChannelError && [401, 410].includes(error.status));
        await this.sql.query(
          `update channel_outbox set status = $2, attempts = $3, error = $4, next_attempt_at = now() + make_interval(secs => $5) where id = $1`,
          [row.id, final ? "failed" : "pending", attempts, String(error instanceof Error ? error.message : error).slice(0, 500), 5 * 2 ** attempts],
        );
      }
    }
  }

  private async buttons(approvals: { action_id: string; summary: string }[]) {
    if (!approvals.length) return [];
    const rows = await this.sql.query<{ id: string; channel_seq: number | null }>(`select id, channel_seq from xodo_actions where id = any($1::uuid[])`, [
      approvals.map((a) => a.action_id),
    ]);
    const seq = new Map(rows.map((r) => [r.id, r.channel_seq]));
    return approvals.map((a, i) => ({ actionId: a.action_id, n: Number(seq.get(a.action_id) ?? i + 1) }));
  }

  /** Avisos do sino (lembretes, pedidos de aprovação, rotinas que falharam) também chegam no canal. */
  private async forwardNotices() {
    const conns = await this.sql.query<ConnectionRow & { created_at: string }>(
      `select *, created_at::text from integration_connections
        where agency_id = $1 and provider in ('telegram', 'whatsapp_cloud') and status = 'active' and coalesce(metadata->>'avisos', 'true') <> 'false'`,
      [this.owner],
    );
    const notices = await this.sql.query<{ id: string; title: string; body: string; data: unknown; created_at: string }>(
      `update notifications n set channel_sent_at = now()
        where n.id in (select id from notifications where agency_id = $1 and channel_sent_at is null order by created_at limit 20)
       returning n.id, n.title, n.body, n.data, n.created_at::text`,
      [this.owner],
    );
    if (!notices.length || !conns.length) return;
    for (const n of notices) {
      // O que veio de uma conversa de canal já apareceu lá (com os botões); não repete.
      const runId = (parseJson<{ run_id?: string }>(n.data) as { run_id?: string })?.run_id;
      if (runId && (await one(this.sql, `select 1 from xodo_runs where id = $1 and conversation_id is not null`, [runId]))) continue;
      for (const conn of conns) {
        if (new Date(n.created_at) < new Date(conn.created_at)) continue;
        const to = await this.ownerChat(conn);
        if (!to) continue;
        const text = n.body ? `🔔 ${n.title}\n\n${n.body}` : `🔔 ${n.title}`;
        await this.sendText(conn, to, text).catch((e) => console.warn("[canais] aviso não enviado", conn.label, e instanceof Error ? e.message : e));
      }
    }
  }

  private async sendText(conn: ConnectionRow, to: string, text: string, approvals: { actionId: string; n: number }[] = []) {
    const secret = await readSecret(this.integ, conn);
    const token = secret.apiKey ?? "";
    const parts = splitParts(text);
    if (conn.provider === "telegram") {
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        const keyboard = last && approvals.length
          ? { inline_keyboard: approvals.map((a) => [{ text: `✅ Pode (${a.n})`, callback_data: `ok:${a.actionId}` }, { text: `❌ Não (${a.n})`, callback_data: `no:${a.actionId}` }]) }
          : undefined;
        await telegram(this.integ.fetch, token, "sendMessage", { chat_id: to, text: parts[i], ...(keyboard ? { reply_markup: keyboard } : {}) });
      }
      return;
    }
    if (approvals.length) {
      parts[parts.length - 1] += `\n\nResponda ${approvals.map((a) => `*aprovar ${a.n}*`).join(", ")} ou ${approvals.map((a) => `*negar ${a.n}*`).join(", ")}.`;
    }
    for (const part of parts) {
      await whatsapp(this.integ.fetch, token, `${conn.external_account}/messages`, { messaging_product: "whatsapp", to: digits(to), type: "text", text: { body: part } });
    }
  }
}

function validSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(raw).digest("hex"));
  const given = Buffer.from(header.slice(7));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; text?: string; from?: TelegramUser; chat: { id: number; type: string } };
  callback_query?: { id: string; data?: string; from: TelegramUser; message?: { message_id: number; chat: { id: number } } };
};
type WhatsappWebhook = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: {
          id: string;
          from: string;
          type: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: { button_reply?: { title?: string } };
        }[];
      };
    }[];
  }[];
};
