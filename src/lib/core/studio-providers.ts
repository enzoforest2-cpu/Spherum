import { randomUUID } from "node:crypto";
import { access, saveConnection, type IntegrationDeps } from "../integrations/store";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { documentsStorage, MAX_DOCUMENT_BYTES, safeFileName } from "./documents";
import type { Generator, Signer, Store, StudioDeps } from "./studio";

/** Geração na fal.ai (imagem síncrona, vídeo em fila) ou no Replicate (imagem). */

async function post<T>(deps: IntegrationDeps, url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120_000): Promise<T> {
  let r: Response;
  try {
    r = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new XodoError(`Não consegui falar com o provedor (${error instanceof Error ? error.message : error}).`, 502);
  }
  return parse<T>(r);
}
async function get<T>(deps: IntegrationDeps, url: string, headers: Record<string, string>): Promise<T> {
  const r = await deps.fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) });
  return parse<T>(r);
}
async function parse<T>(r: Response): Promise<T> {
  const text = await r.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* sem JSON */ }
  if (r.status === 401 || r.status === 403) throw new XodoError("O provedor recusou a chave. Confira a chave em Estúdio.", 401);
  if (!r.ok) {
    const d = data as { detail?: unknown; error?: unknown; message?: unknown };
    const msg = typeof d.detail === "string" ? d.detail : Array.isArray(d.detail) ? JSON.stringify(d.detail).slice(0, 200) : String(d.error ?? d.message ?? `HTTP ${r.status}`);
    throw new XodoError(`O provedor recusou: ${msg.slice(0, 300)}`, r.status === 429 ? 429 : 502);
  }
  return data as T;
}

export function studioGenerator(deps: IntegrationDeps): Generator {
  const key = async (agencyId: string, connectionId: string) => (await access(deps, agencyId, connectionId)).accessToken;
  return {
    async images(agencyId, cfg, prompt, n, format) {
      const k = await key(agencyId, cfg.connection_id);
      if (cfg.provider === "fal") {
        const r = await post<{ images?: { url: string; content_type?: string }[] }>(deps, `https://fal.run/${cfg.image_model}`, { authorization: `Key ${k}` },
          { prompt, num_images: n, image_size: format === "feed" ? "square_hd" : "portrait_16_9", enable_safety_checker: true });
        if (!r.images?.length) throw new XodoError("O provedor não devolveu imagens.", 502);
        return r.images.map((i) => ({ url: i.url, mime: i.content_type ?? "image/png" }));
      }
      const out: { url: string; mime: string }[] = [];
      for (let i = 0; i < n; i++) {
        const r = await post<{ output?: string | string[]; status?: string; error?: string }>(deps, `https://api.replicate.com/v1/models/${cfg.image_model}/predictions`,
          { authorization: `Bearer ${k}`, prefer: "wait=60" }, { input: { prompt, aspect_ratio: format === "feed" ? "1:1" : "9:16" } });
        const url = Array.isArray(r.output) ? r.output[0] : r.output;
        if (!url) throw new XodoError(r.error ? `O provedor recusou: ${r.error}` : "A imagem ainda não ficou pronta. Tente de novo.", 502);
        out.push({ url, mime: url.endsWith(".png") ? "image/png" : url.endsWith(".webp") ? "image/webp" : "image/jpeg" });
      }
      return out;
    },
    async video(agencyId, cfg, prompt, imageUrl) {
      if (cfg.provider !== "fal" || !cfg.video_model) throw new XodoError("Vídeo só pela fal.ai.", 400);
      const r = await post<{ request_id: string; status_url: string; response_url: string }>(deps, `https://queue.fal.run/${cfg.video_model}`, { authorization: `Key ${await key(agencyId, cfg.connection_id)}` }, { prompt, image_url: imageUrl }, 30_000);
      // As URLs de status e resultado vêm da fila (o caminho delas não é o do modelo inteiro).
      return { request_id: JSON.stringify({ id: r.request_id, status: r.status_url, response: r.response_url }) };
    },
    async videoStatus(agencyId, cfg, requestId) {
      const k = await key(agencyId, cfg.connection_id);
      const j = JSON.parse(requestId) as { id: string; status: string; response: string };
      const s = await get<{ status?: string }>(deps, j.status, { authorization: `Key ${k}` });
      if (s.status !== "COMPLETED") return { status: "fila" };
      const r = await get<{ video?: { url?: string }; detail?: unknown }>(deps, j.response, { authorization: `Key ${k}` });
      return r.video?.url ? { status: "pronto", url: r.video.url } : { status: "falhou", error: "O provedor não devolveu o vídeo." };
    },
  };
}

/** Baixa o arquivo gerado e guarda em Documentos (Criativos, do cliente). */
export function documentStore(sql: Sql, fetchImpl: typeof fetch = fetch): Store {
  return async (agencyId, clientId, name, url, mime) => {
    const store = documentsStorage();
    if (!store) throw new XodoError("O armazenamento de arquivos não está configurado.", 503);
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new XodoError("Não consegui baixar o arquivo gerado.", 502);
    const data = new Uint8Array(await r.arrayBuffer());
    if (!data.byteLength || data.byteLength > MAX_DOCUMENT_BYTES) throw new XodoError("Arquivo gerado vazio ou grande demais.", 502);
    const path = `${agencyId}/${clientId}/${randomUUID()}-${safeFileName(name)}`;
    await store.upload(path, data, r.headers.get("content-type") || mime);
    return (await one<{ id: string }>(sql, `insert into documents (agency_id, client_id, name, category, mime, size_bytes, storage_path, status) values ($1, $2, $3, 'Criativos', $4, $5, $6, 'ready') returning id`,
      [agencyId, clientId, name, r.headers.get("content-type") || mime, data.byteLength, path]))!.id;
  };
}

export function documentSigner(sql: Sql): Signer {
  return async (agencyId, ids) => {
    const store = documentsStorage();
    if (!store) return {};
    const docs = await sql.query<{ id: string; storage_path: string }>(`select id, storage_path from documents where agency_id = $1 and id = any($2::uuid[]) and status = 'ready'`, [agencyId, ids]);
    const out: Record<string, string> = {};
    for (const d of docs) out[d.id] = await store.signedDownloadUrl(d.storage_path, 3600);
    return out;
  };
}

/** Guarda a chave da fal.ai ou o token do Replicate (o do Replicate é conferido na hora). */
export async function connectStudio(deps: IntegrationDeps, agencyId: string, userId: string, provider: "fal" | "replicate", key: string) {
  const k = key.trim();
  if (!/^[A-Za-z0-9_:.-]{10,300}$/.test(k)) throw new XodoError("Chave inválida.", 400);
  if (provider === "replicate") await get(deps, "https://api.replicate.com/v1/account", { authorization: `Bearer ${k}` });
  return saveConnection(deps, { agencyId, provider, label: provider === "fal" ? "fal.ai" : "Replicate", account: `${provider}:${k.slice(-6)}`, secret: { apiKey: k }, createdBy: userId });
}

export async function studioDeps(sql: Sql): Promise<StudioDeps> {
  const { serverIntegrations } = await import("../integrations");
  const integrations = { sql, ...serverIntegrations() };
  return { sql, gen: studioGenerator(integrations), store: documentStore(sql, integrations.fetch), sign: documentSigner(sql) };
}
