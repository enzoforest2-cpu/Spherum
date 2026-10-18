import { z } from "zod";
import type { Category } from "../../xodos/policy";
import { appCall, ToolError, openApp, type ToolDef } from "../../xodos/tools";
import { IntegrationError, requestJson } from "../http";
import { clip, tool } from "./common";

/**
 * Slack da agência como ferramenta: listar canais, ler conversas, mandar mensagem e reagir.
 * Mensagem em canal interno é trabalho de "equipe"; em canal compartilhado com outra empresa
 * (Slack Connect) ou para alguém de fora, é "envio".
 */

const SLACK = "https://slack.com/api";

type Slack = Awaited<ReturnType<typeof openApp>>;
type Channel = {
  id: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  is_org_shared?: boolean;
  user?: string;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
};
type SlackMessage = { ts: string; user?: string; bot_id?: string; username?: string; text?: string; thread_ts?: string; reply_count?: number; subtype?: string };
type User = { id: string; name?: string; real_name?: string; team_id?: string; is_stranger?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string } };

const get = <T>(s: Slack, method: string, params: Record<string, string>) =>
  appCall(() => requestJson<T>(s.http, `${SLACK}/${method}?${new URLSearchParams(params)}`, { bearer: s.accessToken }));
const post = <T>(s: Slack, method: string, json: Record<string, unknown>) =>
  requestJson<T>(s.http, `${SLACK}/${method}`, { method: "POST", json, bearer: s.accessToken });

async function allChannels(s: Slack): Promise<Channel[]> {
  const out: Channel[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const r = await get<{ channels?: Channel[]; response_metadata?: { next_cursor?: string } }>(s, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "1000",
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(r.channels ?? []));
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

/** Aceita o id do canal (C…, G…, D…) ou o nome com ou sem #. */
async function channelId(s: Slack, ref: string): Promise<string> {
  const clean = ref.trim();
  if (/^[CGD][A-Z0-9]{6,}$/.test(clean)) return clean;
  const name = clean.replace(/^#/, "").toLowerCase();
  const found = (await allChannels(s)).find((c) => c.name?.toLowerCase() === name);
  if (!found) throw new ToolError(`Canal "${ref}" não encontrado (ou o app do Spherum não tem acesso a ele).`);
  return found.id;
}

/** Nomes das pessoas (uma chamada por pessoa, com cache dentro da mesma ferramenta). */
function userNames(s: Slack) {
  const cache = new Map<string, User | null>();
  const user = async (id: string) => {
    if (!cache.has(id)) {
      try {
        cache.set(id, (await get<{ user: User }>(s, "users.info", { user: id })).user);
      } catch {
        cache.set(id, null);
      }
    }
    return cache.get(id) ?? null;
  };
  return {
    user,
    async name(id: string) {
      const u = await user(id);
      return u?.profile?.display_name || u?.real_name || u?.name || id;
    },
  };
}

/** Canal ou conversa com alguém de fora da empresa? */
export async function slackCategory(s: Slack, channel: string): Promise<Category> {
  const { channel: c } = await get<{ channel: Channel }>(s, "conversations.info", { channel });
  if (c.is_ext_shared || c.is_pending_ext_shared || (c.is_shared && !c.is_org_shared)) return "envio";
  if (c.is_im && c.user) {
    const team = (s.connection.metadata as { team_id?: string })?.team_id;
    const { user } = await get<{ user: User }>(s, "users.info", { user: c.user });
    if (user.is_stranger || (team && user.team_id && user.team_id !== team)) return "envio";
  }
  return "equipe";
}

const where = {
  canal: z.string().max(100).optional().describe("Id ou nome do canal (#geral)"),
  usuario: z.string().regex(/^[UW][A-Z0-9]{6,}$/).optional().describe("Id da pessoa, para mensagem direta"),
};
const oneTarget = [
  (i: { canal?: string; usuario?: string }) => Boolean(i.canal) !== Boolean(i.usuario),
  { message: "Informe o canal ou a pessoa (um dos dois)." },
] as const;

const sendInput = z
  .object({
    ...where,
    texto: z.string().min(1).max(10_000),
    responder_em: z.string().regex(/^\d+\.\d+$/).optional().describe("ts da mensagem para responder na conversa (thread)"),
  })
  .refine(...oneTarget);
type SendInput = z.infer<typeof sendInput>;

async function resolveTarget(s: Slack, i: { canal?: string; usuario?: string }): Promise<string> {
  if (i.usuario) {
    const r = await appCall(() => post<{ channel: { id: string } }>(s, "conversations.open", { users: i.usuario }));
    return r.channel.id;
  }
  return channelId(s, i.canal!);
}

export const SLACK_TOOLS: ToolDef[] = [
  tool({
    name: "listar_canais_do_slack",
    description: "Canais do Slack da agência que o app do Spherum enxerga, dizendo quais são compartilhados com outras empresas.",
    category: "leitura",
    app: "slack",
    input: z.object({ busca: z.string().max(100).optional() }),
    summarize: () => "listar canais do Slack",
    async execute(ctx, i) {
      const s = await openApp(ctx, "slack");
      const q = i.busca?.replace(/^#/, "").toLowerCase();
      const channels = (await allChannels(s)).filter((c) => !q || c.name?.toLowerCase().includes(q));
      return {
        canais: channels.slice(0, 200).map((c) => ({
          id: c.id,
          nome: `#${c.name}`,
          privado: c.is_private ?? false,
          app_participa: c.is_member ?? false,
          compartilhado_com_outra_empresa: Boolean(c.is_ext_shared || c.is_pending_ext_shared),
          pessoas: c.num_members ?? null,
          tema: c.topic?.value || c.purpose?.value || null,
        })),
      };
    },
  }),
  tool({
    name: "ler_canal_do_slack",
    description: "Últimas mensagens de um canal ou de uma conversa (thread) do Slack, da mais antiga para a mais nova.",
    category: "leitura",
    app: "slack",
    input: z
      .object({
        ...where,
        quantidade: z.number().int().min(1).max(100).default(30),
        conversa: z.string().regex(/^\d+\.\d+$/).optional().describe("ts da mensagem que abre a conversa (thread)"),
      })
      .refine(...oneTarget),
    summarize: (i) => `ler o Slack${i.canal ? ` em ${i.canal}` : ""}`,
    async execute(ctx, i) {
      const s = await openApp(ctx, "slack");
      const channel = await resolveTarget(s, i);
      const r = i.conversa
        ? await get<{ messages?: SlackMessage[] }>(s, "conversations.replies", { channel, ts: i.conversa, limit: String(i.quantidade) })
        : await get<{ messages?: SlackMessage[] }>(s, "conversations.history", { channel, limit: String(i.quantidade) });
      const names = userNames(s);
      const messages = (r.messages ?? []).filter((m) => !m.subtype || m.subtype === "thread_broadcast" || m.subtype === "bot_message");
      // history vem da mais nova para a mais antiga; replies, ao contrário.
      const ordered = i.conversa ? messages : [...messages].reverse();
      return {
        canal: channel,
        mensagens: await Promise.all(
          ordered.map(async (m) => ({
            ts: m.ts,
            quem: m.user ? await names.name(m.user) : (m.username ?? "app"),
            texto: clip(m.text ?? "", 3_000),
            conversa: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
            respostas: m.reply_count ?? 0,
          })),
        ),
      };
    },
  }),
  tool({
    name: "enviar_mensagem_no_slack",
    description:
      "Manda uma mensagem num canal, numa conversa (thread) ou direto para uma pessoa no Slack da agência. Em canal compartilhado com outra empresa, segue a autonomia de envio.",
    category: "envio",
    app: "slack",
    input: sendInput,
    summarize: (i: SendInput) => `mandar mensagem no Slack para ${i.canal ?? i.usuario}: "${clip(i.texto, 120)}"`,
    async categoryFor(ctx, i: SendInput) {
      const s = await openApp(ctx, "slack");
      return slackCategory(s, await resolveTarget(s, i));
    },
    async execute(ctx, i: SendInput) {
      const s = await openApp(ctx, "slack");
      const channel = await resolveTarget(s, i);
      const message = { channel, text: i.texto, ...(i.responder_em ? { thread_ts: i.responder_em } : {}) };
      let sent: { ts: string; channel: string };
      try {
        sent = await post(s, "chat.postMessage", message);
      } catch (error) {
        // Em canal público em que o app ainda não está, entra e tenta de novo.
        if (!(error instanceof IntegrationError) || !/not_in_channel/.test(error.message)) {
          throw error instanceof IntegrationError ? new ToolError(error.message) : error;
        }
        await appCall(() => post(s, "conversations.join", { channel }));
        sent = await appCall(() => post<{ ts: string; channel: string }>(s, "chat.postMessage", message));
      }
      return { enviado: true, canal: sent.channel, ts: sent.ts };
    },
  }),
  tool({
    name: "reagir_no_slack",
    description: "Põe uma reação (emoji) numa mensagem do Slack, por exemplo para avisar que viu (eyes) ou que terminou (white_check_mark).",
    category: "equipe",
    app: "slack",
    input: z.object({
      canal: z.string().max(100),
      ts: z.string().regex(/^\d+\.\d+$/),
      emoji: z.string().regex(/^[a-z0-9_+-]{1,50}$/).describe("Nome do emoji sem os dois-pontos"),
    }),
    summarize: (i) => `reagir com :${i.emoji}: no Slack`,
    async execute(ctx, i) {
      const s = await openApp(ctx, "slack");
      const channel = await channelId(s, i.canal);
      await appCall(() => post(s, "reactions.add", { channel, timestamp: i.ts, name: i.emoji }));
      return { reagiu: i.emoji };
    },
  }),
];
