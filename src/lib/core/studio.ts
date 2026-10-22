import { z } from "zod";
import { json, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { createPost } from "./content";

/**
 * Estúdio: criativos com IA na conta da própria agência (fal.ai ou Replicate). O pedido da equipe
 * vira um prompt com o kit da marca do cliente (produto, estilo, cores) e sempre deixa espaço livre
 * para o título: logo, preço e texto entram depois, como camadas. Imagens vão para Documentos
 * (Criativos); vídeo anima uma imagem e roda em fila (o cron busca o resultado).
 */

export type GenConfig = { provider: "fal" | "replicate"; connection_id: string; image_model: string; video_model: string | null };
export type Generator = {
  images(agencyId: string, cfg: GenConfig, prompt: string, n: number, format: "feed" | "story"): Promise<{ url: string; mime: string }[]>;
  video(agencyId: string, cfg: GenConfig, prompt: string, imageUrl: string): Promise<{ request_id: string }>;
  videoStatus(agencyId: string, cfg: GenConfig, requestId: string): Promise<{ status: "fila" | "pronto" | "falhou"; url?: string; error?: string }>;
};
/** Guarda o arquivo gerado em Documentos (Criativos) e devolve o id. */
export type Store = (agencyId: string, clientId: string, name: string, url: string, mime: string) => Promise<string>;
/** Link temporário para mostrar a imagem na tela (ou mandar para o modelo de vídeo). */
export type Signer = (agencyId: string, documentIds: string[]) => Promise<Record<string, string>>;
export type StudioDeps = { sql: Sql; gen: Generator; store: Store; sign: Signer };

/** Imagens e vídeos por mês em cada plano (nulo: sem limite). */
export const PLAN_LIMITS: Record<string, [number | null, number | null]> = { solo: [0, 0], agencia: [40, 0], escala: [150, 20], rede: [500, 80], empresarial: [null, null] };
export const DEFAULT_MODELS = {
  fal: { image: "fal-ai/qwen-image", video: "fal-ai/wan/v2.2-a14b/image-to-video" },
  replicate: { image: "qwen/qwen-image", video: null },
} as const;

export const kitInput = z.object({
  color1: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(), color2: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
  font: z.string().trim().max(60).nullable(), product: z.string().trim().max(120).nullable(), headline: z.string().trim().max(120).nullable(),
  price: z.string().trim().max(40).nullable(), cta: z.string().trim().max(40).nullable(), style: z.string().trim().max(500).nullable(), logo_document_id: z.uuid().nullable(),
}).partial();
type Kit = z.infer<typeof kitInput>;

async function clientOf(sql: Sql, agencyId: string, clientId: string) {
  const c = await one<{ name: string; segment: string | null }>(sql, `select name, segment from clients where id = $1 and agency_id = $2`, [clientId, agencyId]);
  if (!c) throw new XodoError("Cliente não encontrado.", 404);
  return c;
}

export async function setKit(sql: Sql, agencyId: string, clientId: string, raw: unknown) {
  const i = kitInput.parse(raw);
  await clientOf(sql, agencyId, clientId);
  if (i.logo_document_id && !(await one(sql, `select 1 from documents where id = $1 and agency_id = $2 and status = 'ready'`, [i.logo_document_id, agencyId]))) throw new XodoError("Logo não encontrado em Documentos.", 400);
  const keys = Object.keys(i) as (keyof Kit)[];
  await sql.query(`insert into client_brand_kits (client_id, agency_id) values ($1, $2) on conflict do nothing`, [clientId, agencyId]);
  if (keys.length) await sql.query(`update client_brand_kits set ${keys.map((k, n) => `${k} = $${n + 2}`).join(", ")}, updated_at = now() where client_id = $1`, [clientId, ...keys.map((k) => i[k] ?? null)]);
}

export const configInput = z.object({ provider: z.enum(["fal", "replicate"]), connection_id: z.uuid(), image_model: z.string().trim().regex(/^[\w.-]+\/[\w./:-]+$/).optional(), video_model: z.string().trim().regex(/^[\w.-]+\/[\w./:-]+$/).nullable().optional() });

export async function getConfig(sql: Sql, agencyId: string): Promise<GenConfig | null> {
  const c = (await one<{ c: Partial<GenConfig> }>(sql, `select studio_config as c from agencies where id = $1`, [agencyId]))?.c;
  if (!c?.provider || !c.connection_id) return null;
  return { provider: c.provider, connection_id: c.connection_id, image_model: c.image_model ?? DEFAULT_MODELS[c.provider].image, video_model: c.video_model === undefined ? DEFAULT_MODELS[c.provider].video : c.video_model };
}

export async function setConfig(sql: Sql, agencyId: string, raw: unknown) {
  const i = configInput.parse(raw);
  const conn = await one<{ provider: string }>(sql, `select provider from integration_connections where id = $1 and agency_id = $2 and status <> 'revoked'`, [i.connection_id, agencyId]);
  if (!conn || conn.provider !== i.provider) throw new XodoError(`Escolha uma conexão ${i.provider === "fal" ? "da fal.ai" : "do Replicate"}.`, 400);
  await sql.query(`update agencies set studio_config = $2::jsonb where id = $1`, [agencyId, json({ provider: i.provider, connection_id: i.connection_id, image_model: i.image_model ?? DEFAULT_MODELS[i.provider].image, video_model: i.video_model === undefined ? DEFAULT_MODELS[i.provider].video : i.video_model })]);
}

/** O pedido vira um prompt com o kit da marca. */
export function buildPrompt(text: string, client: { name: string; segment: string | null }, kit: Kit | null, format: "feed" | "story" | "video") {
  const parts = [
    `Fotografia publicitária profissional para ${client.name}${client.segment ? ` (${client.segment})` : ""}.`,
    kit?.product ? `Produto em destaque: ${kit.product}.` : "",
    /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`,
    kit?.style ? `Estilo da marca: ${kit.style}.` : "",
    kit?.color1 ? `Use as cores da marca (${[kit.color1, kit.color2].filter(Boolean).join(" e ")}) na composição.` : "",
    "Sem textos, letras ou logotipos na imagem; deixe uma área limpa para o título.",
    format === "feed" ? "Enquadramento quadrado (1:1)." : "Enquadramento vertical (9:16).",
  ];
  return parts.filter(Boolean).join(" ").slice(0, 1800);
}

async function usage(sql: Sql, agencyId: string, now: Date) {
  const plan = (await one<{ plan: string | null }>(sql, `select plan from agencies where id = $1`, [agencyId]))?.plan ?? "agencia";
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const r = await one<{ img: number; vid: number }>(
    sql,
    `select coalesce(sum(cardinality(document_ids)) filter (where format <> 'video'), 0)::int as img,
            (select count(*)::int from studio_jobs where agency_id = $1 and created_at >= $2 and status <> 'falhou') as vid
       from studio_messages where agency_id = $1 and role = 'ai' and created_at >= $2`, [agencyId, month]);
  const lim = PLAN_LIMITS[plan] ?? PLAN_LIMITS.agencia;
  return { plan, images: r!.img, videos: r!.vid, image_limit: lim[0], video_limit: lim[1] };
}

const say = (sql: Sql, agencyId: string, clientId: string, role: "me" | "ai" | "sys", text: string, extra: { docs?: string[]; format?: string | null; user?: string | null } = {}) =>
  one<{ id: number }>(sql, `insert into studio_messages (agency_id, client_id, role, text, document_ids, format, author_user) values ($1, $2, $3, $4, $5::uuid[], $6, $7) returning id`,
    [agencyId, clientId, role, text.slice(0, 2000), extra.docs ?? [], extra.format ?? null, extra.user ?? null]);

export const generateInput = z.object({ text: z.string().trim().min(3).max(1000), format: z.enum(["feed", "story"]).default("feed"), count: z.number().int().min(1).max(4).default(4) });

/** Gera as imagens do pedido, guarda em Documentos e registra na conversa do cliente. */
export async function generate(deps: StudioDeps, agencyId: string, userId: string, clientId: string, raw: unknown, now = new Date()) {
  const { sql } = deps;
  const i = generateInput.parse(raw);
  const client = await clientOf(sql, agencyId, clientId);
  const cfg = await getConfig(sql, agencyId);
  if (!cfg) throw new XodoError("Conecte a fal.ai ou o Replicate no Estúdio para gerar imagens.", 400);
  const u = await usage(sql, agencyId, now);
  if (u.image_limit !== null && u.images + i.count > u.image_limit) throw new XodoError(u.image_limit === 0 ? "O Estúdio não está no seu plano." : `Limite de ${u.image_limit} imagens no mês do plano (${u.images} usadas).`, 402);
  const kit = await one<Kit>(sql, `select color1, color2, font, product, headline, price, cta, style, logo_document_id from client_brand_kits where client_id = $1`, [clientId]);
  await say(sql, agencyId, clientId, "me", i.text, { user: userId, format: i.format });
  const prompt = buildPrompt(i.text, client, kit, i.format);
  let out: { url: string; mime: string }[];
  try {
    out = await deps.gen.images(agencyId, cfg, prompt, i.count, i.format);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await say(sql, agencyId, clientId, "sys", `Não consegui gerar agora: ${msg}`);
    throw error instanceof XodoError ? error : new XodoError(`O provedor recusou: ${msg}`, 502);
  }
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const docs: string[] = [];
  for (const [n, img] of out.entries()) docs.push(await deps.store(agencyId, clientId, `estudio-${stamp}-${n + 1}.${img.mime.includes("png") ? "png" : img.mime.includes("webp") ? "webp" : "jpg"}`, img.url, img.mime));
  const m = await say(sql, agencyId, clientId, "ai", `Gerei ${docs.length} ${docs.length === 1 ? "opção" : "opções"} com o ${cfg.image_model.split("/").pop()}${kit?.product ? `, com ${kit.product}` : ""}. A área do título ficou livre para o texto e o logo.`, { docs, format: i.format });
  return { message_id: m!.id, document_ids: docs };
}

/** Anima uma imagem gerada (vídeo curto). Fica na fila do provedor; o cron busca o resultado. */
export async function animate(deps: StudioDeps, agencyId: string, userId: string, clientId: string, documentId: string, text: string, now = new Date()) {
  const { sql } = deps;
  await clientOf(sql, agencyId, clientId);
  const cfg = await getConfig(sql, agencyId);
  if (!cfg || !cfg.video_model) throw new XodoError("Vídeo precisa da fal.ai com um modelo de vídeo.", 400);
  const u = await usage(sql, agencyId, now);
  if (u.video_limit !== null && u.videos + 1 > u.video_limit) throw new XodoError(u.video_limit === 0 ? "Vídeo não está no seu plano." : `Limite de ${u.video_limit} vídeos no mês do plano.`, 402);
  if (!(await one(sql, `select 1 from documents where id = $1 and agency_id = $2 and status = 'ready' and mime like 'image/%'`, [documentId, agencyId]))) throw new XodoError("Imagem não encontrada.", 404);
  const url = (await deps.sign(agencyId, [documentId]))[documentId];
  const t = z.string().trim().min(3).max(500).parse(text);
  const m = await say(sql, agencyId, clientId, "me", `Animar: ${t}`, { user: userId, format: "video" });
  const job = await deps.gen.video(agencyId, cfg, `${t}. Movimento suave de câmera, 5 segundos, sem texto.`, url);
  await sql.query(`insert into studio_jobs (agency_id, client_id, message_id, provider, model, request_id) values ($1, $2, $3, $4, $5, $6)`, [agencyId, clientId, m!.id, cfg.provider, cfg.video_model, job.request_id]);
  await say(sql, agencyId, clientId, "sys", "Vídeo na fila do provedor. Aparece aqui em alguns minutos.");
}

/** Cron: busca os vídeos prontos. */
export async function videoSweep(deps: StudioDeps, opts: { deadline?: number } = {}) {
  const { sql } = deps;
  const jobs = await sql.query<{ id: string; agency_id: string; client_id: string; request_id: string; model: string; created_at: string }>(
    `select id, agency_id, client_id, request_id, model, created_at::text from studio_jobs where status = 'fila' order by created_at limit 20`);
  let done = 0;
  for (const j of jobs) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    const cfg = await getConfig(sql, j.agency_id);
    if (!cfg) continue;
    try {
      const s = await deps.gen.videoStatus(j.agency_id, cfg, j.request_id);
      if (s.status === "pronto" && s.url) {
        const doc = await deps.store(j.agency_id, j.client_id, `estudio-video-${j.id.slice(0, 8)}.mp4`, s.url, "video/mp4");
        await sql.query(`update studio_jobs set status = 'pronto', document_id = $2 where id = $1`, [j.id, doc]);
        await say(sql, j.agency_id, j.client_id, "ai", `Vídeo pronto (${j.model.split("/").pop()}).`, { docs: [doc], format: "video" });
        done++;
      } else if (s.status === "falhou" || Date.now() - Date.parse(j.created_at) > 2 * 3600_000) {
        await sql.query(`update studio_jobs set status = 'falhou', error = $2 where id = $1`, [j.id, (s.error ?? "Demorou demais no provedor.").slice(0, 500)]);
        await say(sql, j.agency_id, j.client_id, "sys", `O vídeo não saiu: ${s.error ?? "demorou demais no provedor"}.`);
      }
    } catch (error) {
      console.warn("[estudio] vídeo", j.id, error instanceof Error ? error.message : error);
    }
  }
  return { videos: done };
}

/** Criativo aprovado vira rascunho no Conteúdo (para mandar ao cliente ou agendar). */
export async function toContent(sql: Sql, agencyId: string, userId: string, clientId: string, raw: unknown) {
  const i = z.object({ document_ids: z.array(z.uuid()).min(1).max(10), title: z.string().trim().min(1).max(120), caption: z.string().max(2200).default(""), publish_at: z.iso.datetime({ offset: true }), nets: z.array(z.enum(["IG", "FB"])).min(1).default(["IG"]) }).parse(raw);
  const video = await one(sql, `select 1 from documents where id = any($1::uuid[]) and mime like 'video/%'`, [i.document_ids]);
  return createPost(sql, agencyId, userId, { client_id: clientId, title: i.title, caption: i.caption, publish_at: i.publish_at, media_ids: i.document_ids, nets: i.nets, kind: video ? "reels" : i.document_ids.length > 1 ? "carrossel" : "post" });
}

export async function studioBoard(deps: Pick<StudioDeps, "sql" | "sign">, agencyId: string, clientId: string, now = new Date()) {
  const { sql } = deps;
  const client = await clientOf(sql, agencyId, clientId);
  const [kit, messages, cfg, u, jobs] = await Promise.all([
    one<Kit>(sql, `select color1, color2, font, product, headline, price, cta, style, logo_document_id from client_brand_kits where client_id = $1`, [clientId]),
    sql.query<{ id: number; role: string; text: string; document_ids: string[]; format: string | null; created_at: string }>(
      `select * from (select id, role, text, document_ids, format, created_at::text from studio_messages where client_id = $1 order by id desc limit 60) m order by id`, [clientId]),
    getConfig(sql, agencyId),
    usage(sql, agencyId, now),
    one<{ n: number }>(sql, `select count(*)::int as n from studio_jobs where client_id = $1 and status = 'fila'`, [clientId]),
  ]);
  const ids = [...new Set(messages.flatMap((m) => m.document_ids))];
  const urls = ids.length ? await deps.sign(agencyId, ids).catch(() => ({} as Record<string, string>)) : {};
  return { client: client.name, kit, config: cfg, usage: u, pending_videos: jobs!.n, messages: messages.map((m) => ({ ...m, id: Number(m.id) })), urls };
}
