import { z } from "zod";
import { appCall, ToolError, openApp, type ToolDef } from "../../xodos/tools";
import { requestJson } from "../http";
import { addresses, audience, clip, htmlToText, internalOnly, tool } from "./common";

/**
 * Gmail da conta Google conectada: buscar, ler, rascunhar, enviar, organizar e mandar para a
 * lixeira. Enviar para gente de fora é "envio"; para colegas do mesmo domínio, "equipe".
 */

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
type Message = { id: string; threadId: string; labelIds?: string[]; snippet?: string; payload?: Part };

type Gmail = Awaited<ReturnType<typeof openApp>>;

const call = <T = Record<string, unknown>>(g: Gmail, path: string, init: Parameters<typeof requestJson>[2] = {}) =>
  appCall(() => requestJson<T>(g.http, `${GMAIL}${path}`, { ...init, bearer: g.accessToken }));

const header = (m: Message, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** Texto do e-mail (prefere a parte em texto; senão converte o HTML) e a lista de anexos. */
export function messageBody(payload: Part | undefined) {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: { nome: string; tipo: string; tamanho: number }[] = [];
  const walk = (p: Part | undefined) => {
    if (!p) return;
    if (p.filename) {
      attachments.push({ nome: p.filename, tipo: p.mimeType ?? "", tamanho: p.body?.size ?? 0 });
    } else if (p.body?.data && p.mimeType === "text/plain") {
      plain.push(decode(p.body.data));
    } else if (p.body?.data && p.mimeType === "text/html") {
      html.push(decode(p.body.data));
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  const text = plain.length ? plain.join("\n\n") : htmlToText(html.join("\n"));
  return { text: text.trim(), attachments };
}

function summary(m: Message) {
  return {
    id: m.id,
    conversa: m.threadId,
    de: header(m, "From"),
    para: header(m, "To"),
    assunto: header(m, "Subject"),
    data: header(m, "Date"),
    trecho: m.snippet ?? "",
    nao_lido: m.labelIds?.includes("UNREAD") ?? false,
  };
}

// ---------------------------------------------------------------------------
// Montagem da mensagem
// ---------------------------------------------------------------------------

/** Cabeçalho sem quebras de linha (evita injeção de cabeçalhos) e com acentos em RFC 2047. */
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x00-\x7F]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export function buildRaw(m: { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; inReplyTo?: string | null; references?: string | null }): string {
  const lines = [
    m.to.length ? `To: ${m.to.join(", ")}` : null,
    m.cc.length ? `Cc: ${m.cc.join(", ")}` : null,
    m.bcc.length ? `Bcc: ${m.bcc.join(", ")}` : null,
    `Subject: ${headerValue(m.subject)}`,
    m.inReplyTo ? `In-Reply-To: ${headerValue(m.inReplyTo)}` : null,
    m.references ? `References: ${headerValue(m.references)}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].filter((l): l is string => l !== null);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const emails = z.array(z.email()).max(50).default([]);
const composeInput = z.object({
  para: emails.describe("Destinatários. Ao responder, pode ficar vazio: vai para quem mandou."),
  cc: emails,
  cco: emails,
  assunto: z.string().max(300).optional().describe("Ao responder, pode ficar vazio: usa Re: do original."),
  texto: z.string().min(1).max(50_000).describe("Corpo do e-mail em texto simples."),
  responder_a: z.string().max(64).optional().describe("Id do e-mail que está sendo respondido (mantém na mesma conversa)."),
  responder_todos: z.boolean().default(false).describe("Ao responder, inclui todos que estavam na conversa."),
});
type ComposeInput = z.infer<typeof composeInput>;

type Composed = { to: string[]; cc: string[]; bcc: string[]; subject: string; raw: string; threadId?: string };

async function compose(g: Gmail, i: ComposeInput): Promise<Composed> {
  let { para: to, cc } = i;
  let subject = i.assunto ?? "";
  let threadId: string | undefined;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (i.responder_a) {
    const fields = ["Message-ID", "References", "Subject", "From", "Reply-To", "To", "Cc"].map((h) => `metadataHeaders=${h}`).join("&");
    const original = await call<Message>(g, `/messages/${encodeURIComponent(i.responder_a)}?format=metadata&${fields}`);
    threadId = original.threadId;
    inReplyTo = header(original, "Message-ID");
    references = [header(original, "References"), inReplyTo].filter(Boolean).join(" ") || null;
    if (!subject) {
      const s = header(original, "Subject") ?? "";
      subject = /^re:/i.test(s) ? s : `Re: ${s}`;
    }
    if (!to.length) {
      const me = (g.connection.external_account ?? "").toLowerCase();
      to = addresses(header(original, "Reply-To") ?? header(original, "From"));
      if (i.responder_todos) {
        const others = [...addresses(header(original, "To")), ...addresses(header(original, "Cc"))];
        cc = [...new Set([...cc, ...others])].filter((a) => a !== me && !to.includes(a));
      }
    }
  }
  return {
    to,
    cc,
    bcc: i.cco,
    subject,
    threadId,
    raw: buildRaw({ to, cc, bcc: i.cco, subject, text: i.texto, inReplyTo, references }),
  };
}

const sendInput = composeInput
  .partial({ texto: true })
  .extend({ rascunho_id: z.string().max(64).optional().describe("Envia um rascunho já criado (aí não precisa do resto).") })
  .refine((i) => i.rascunho_id || i.texto, { message: "Informe o texto do e-mail ou o rascunho_id." });
type SendInput = z.infer<typeof sendInput>;

/** Destinatários do que vai sair (do rascunho, se for o caso). */
async function recipientsOf(g: Gmail, i: SendInput): Promise<string[]> {
  if (i.rascunho_id) {
    const d = await call<{ message: Message }>(g, `/drafts/${encodeURIComponent(i.rascunho_id)}?format=metadata`);
    return ["To", "Cc", "Bcc"].flatMap((h) => addresses(header(d.message, h)));
  }
  const c = await compose(g, { ...i, texto: i.texto ?? "" } as ComposeInput);
  return [...c.to, ...c.cc, ...c.bcc];
}

const who = (i: { para?: string[]; responder_a?: string }) =>
  i.para?.length ? i.para.join(", ") : i.responder_a ? "quem mandou o e-mail" : "(sem destinatário)";

/** Ids dos marcadores pelo nome; cria os que não existem quando `create`. */
async function labelIds(g: Gmail, names: string[], create: boolean): Promise<string[]> {
  if (!names.length) return [];
  const { labels = [] } = await call<{ labels?: { id: string; name: string }[] }>(g, "/labels");
  const out: string[] = [];
  for (const name of names) {
    const found = labels.find((l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name);
    if (found) out.push(found.id);
    else if (create) out.push((await call<{ id: string }>(g, "/labels", { method: "POST", json: { name } })).id);
    else throw new ToolError(`Marcador "${name}" não existe no Gmail.`);
  }
  return out;
}

const ids = z.array(z.string().min(1).max(64)).min(1).max(50);

export const GMAIL_TOOLS: ToolDef[] = [
  tool({
    name: "buscar_emails",
    description:
      "Busca e-mails no Gmail conectado. Aceita a sintaxe de busca do Gmail: from:, to:, subject:, is:unread, newer_than:7d, has:attachment, label:.",
    category: "leitura",
    app: "gmail",
    input: z.object({
      busca: z.string().max(500).default("in:inbox"),
      quantidade: z.number().int().min(1).max(25).default(10),
    }),
    summarize: (i) => `buscar e-mails (${i.busca})`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "gmail");
      const list = await call<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(
        g,
        `/messages?${new URLSearchParams({ q: i.busca, maxResults: String(i.quantidade) })}`,
      );
      const fields = ["From", "To", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
      const messages = await Promise.all(
        (list.messages ?? []).map((m) => call<Message>(g, `/messages/${m.id}?format=metadata&${fields}`)),
      );
      return { total_aproximado: list.resultSizeEstimate ?? messages.length, emails: messages.map(summary) };
    },
  }),
  tool({
    name: "ler_email",
    description: "Lê um e-mail inteiro (ou a conversa toda) pelo id que veio de buscar_emails.",
    category: "leitura",
    app: "gmail",
    input: z.object({ id: z.string().min(1).max(64), conversa_inteira: z.boolean().default(false) }),
    summarize: () => "ler e-mail",
    async execute(ctx, i) {
      const g = await openApp(ctx, "gmail");
      const message = await call<Message>(g, `/messages/${encodeURIComponent(i.id)}?format=full`);
      const messages = i.conversa_inteira
        ? ((await call<{ messages?: Message[] }>(g, `/threads/${message.threadId}?format=full`)).messages ?? [message])
        : [message];
      const per = Math.max(2_000, Math.floor(16_000 / messages.length));
      return {
        conversa: message.threadId,
        emails: messages.map((m) => {
          const body = messageBody(m.payload);
          return {
            id: m.id,
            de: header(m, "From"),
            para: header(m, "To"),
            cc: header(m, "Cc"),
            assunto: header(m, "Subject"),
            data: header(m, "Date"),
            texto: clip(body.text, per),
            anexos: body.attachments,
          };
        }),
      };
    },
  }),
  tool({
    name: "rascunho_de_email",
    description: "Cria um rascunho no Gmail (não envia). Bom para a equipe revisar antes de mandar.",
    category: "rascunho",
    app: "gmail",
    input: composeInput,
    summarize: (i) => `criar rascunho de e-mail para ${who(i)}`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "gmail");
      const c = await compose(g, i);
      const draft = await call<{ id: string; message: { id: string; threadId: string } }>(g, "/drafts", {
        method: "POST",
        json: { message: { raw: c.raw, ...(c.threadId ? { threadId: c.threadId } : {}) } },
      });
      return { rascunho_id: draft.id, para: c.to, assunto: c.subject, conversa: draft.message.threadId };
    },
  }),
  tool({
    name: "enviar_email",
    description:
      "Envia um e-mail pelo Gmail conectado (novo, resposta, ou um rascunho pelo rascunho_id). Para gente de fora da empresa, segue a autonomia de envio.",
    category: "envio",
    app: "gmail",
    input: sendInput,
    summarize: (i) =>
      i.rascunho_id ? `enviar o rascunho ${i.rascunho_id}` : `enviar e-mail para ${who(i)}${i.assunto ? `: "${i.assunto}"` : ""}`,
    async categoryFor(ctx, i) {
      const g = await openApp(ctx, "gmail");
      return audience(internalOnly(g.connection.external_account ?? "", await recipientsOf(g, i)));
    },
    async execute(ctx, i) {
      const g = await openApp(ctx, "gmail");
      if (i.rascunho_id) {
        const sent = await call<{ id: string; threadId: string }>(g, "/drafts/send", { method: "POST", json: { id: i.rascunho_id } });
        return { enviado: true, id: sent.id, conversa: sent.threadId };
      }
      const c = await compose(g, i as ComposeInput);
      if (!c.to.length && !c.cc.length && !c.bcc.length) throw new ToolError("O e-mail precisa de pelo menos um destinatário.");
      const sent = await call<{ id: string; threadId: string }>(g, "/messages/send", {
        method: "POST",
        json: { raw: c.raw, ...(c.threadId ? { threadId: c.threadId } : {}) },
      });
      return { enviado: true, id: sent.id, conversa: sent.threadId, para: c.to, assunto: c.subject };
    },
  }),
  tool({
    name: "organizar_emails",
    description: "Marca como lido ou não lido, arquiva e põe ou tira marcadores (cria o marcador se não existir).",
    category: "alteracao",
    app: "gmail",
    input: z.object({
      ids,
      marcar_como_lido: z.boolean().optional(),
      arquivar: z.boolean().optional(),
      adicionar_marcadores: z.array(z.string().min(1).max(100)).max(10).default([]),
      remover_marcadores: z.array(z.string().min(1).max(100)).max(10).default([]),
    }),
    summarize: (i) => `organizar ${i.ids.length} e-mail(s)`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "gmail");
      const add = await labelIds(g, i.adicionar_marcadores, true);
      const remove = await labelIds(g, i.remover_marcadores, false);
      if (i.marcar_como_lido === true) remove.push("UNREAD");
      if (i.marcar_como_lido === false) add.push("UNREAD");
      if (i.arquivar) remove.push("INBOX");
      if (!add.length && !remove.length) throw new ToolError("Nada para mudar.");
      await call(g, "/messages/batchModify", { method: "POST", json: { ids: i.ids, addLabelIds: add, removeLabelIds: remove } });
      return { emails: i.ids.length, adicionados: add, removidos: remove };
    },
  }),
  tool({
    name: "apagar_emails",
    description: "Manda e-mails para a lixeira do Gmail (dá para recuperar por 30 dias).",
    category: "exclusao",
    app: "gmail",
    input: z.object({ ids }),
    summarize: (i) => `mandar ${i.ids.length} e-mail(s) para a lixeira`,
    async execute(ctx, i) {
      const g = await openApp(ctx, "gmail");
      for (const id of i.ids) await call(g, `/messages/${encodeURIComponent(id)}/trash`, { method: "POST" });
      return { na_lixeira: i.ids.length };
    },
  }),
];
