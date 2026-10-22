import { documentsStorage } from "./documents";
import { requestJson } from "../integrations/http";
import { metaGraph } from "../integrations/oauth-providers";
import { access, type IntegrationDeps } from "../integrations/store";
import { XodoError } from "../xodos/errors";
import type { Sql } from "../xodos/db";
import type { ContentDeps, Media, MediaUrls, Publisher } from "./content";

/**
 * Publicação pela API da Meta. Instagram: cria o contêiner (foto, vídeo, carrossel, Reels ou Story),
 * espera o vídeo processar e publica. Facebook: foto, várias fotos num post, vídeo ou só texto, com o
 * token da página (vem do token de quem conectou).
 */

const isVideo = (m: Media) => m.mime.startsWith("video/");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function metaPublisher(deps: IntegrationDeps, wait = sleep): Publisher {
  const g = metaGraph();
  const call = <T>(path: string, bearer: string, init: { method?: string; json?: unknown } = {}) => requestJson<T>(deps.fetch, `${g}/${path}`, { ...init, bearer, timeoutMs: 60_000 });

  async function waitReady(container: string, token: string) {
    // Vídeo processa na Meta antes de poder publicar (até ~3 minutos).
    for (let i = 0; i < 36; i++) {
      const s = await call<{ status_code?: string; status?: string }>(`${container}?fields=status_code,status`, token);
      if (s.status_code === "FINISHED") return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new XodoError(`A Meta não aceitou o vídeo (${s.status ?? s.status_code}).`, 422);
      await wait(5000);
    }
    throw new Error("O vídeo ainda está processando na Meta. Tento de novo no próximo ciclo.");
  }

  return async (a) => {
    const token = (await access(deps, a.agencyId, a.connectionId)).accessToken;
    if (a.net === "IG") {
      const ig = a.igUserId!;
      const item = async (m: Media, extra: Record<string, unknown>) =>
        (await call<{ id: string }>(`${ig}/media`, token, { method: "POST", json: { ...(isVideo(m) ? { video_url: m.url, media_type: extra.media_type ?? "VIDEO" } : { image_url: m.url }), ...extra } })).id;
      let container: string;
      if (a.kind === "carrossel") {
        const children: string[] = [];
        for (const m of a.media) children.push(await item(m, { is_carousel_item: true, ...(isVideo(m) ? { media_type: "VIDEO" } : {}) }));
        for (const c of children) await waitReady(c, token);
        container = (await call<{ id: string }>(`${ig}/media`, token, { method: "POST", json: { media_type: "CAROUSEL", children, caption: a.caption } })).id;
      } else if (a.kind === "reels") {
        if (!isVideo(a.media[0])) throw new XodoError("Reels precisa de um vídeo.", 400);
        container = await item(a.media[0], { media_type: "REELS", caption: a.caption });
      } else if (a.kind === "story") {
        container = await item(a.media[0], { media_type: "STORIES" });
      } else {
        container = await item(a.media[0], isVideo(a.media[0]) ? { media_type: "REELS", caption: a.caption } : { caption: a.caption });
      }
      await waitReady(container, token);
      const pub = await call<{ id: string }>(`${ig}/media_publish`, token, { method: "POST", json: { creation_id: container } });
      const link = await call<{ permalink?: string }>(`${pub.id}?fields=permalink`, token).catch(() => ({ permalink: undefined }));
      return { id: pub.id, url: link.permalink ?? null };
    }
    // Facebook: token da página.
    const page = await call<{ access_token?: string }>(`${a.pageId}?fields=access_token`, token);
    if (!page.access_token) throw new XodoError("A conta conectada não administra esta página do Facebook.", 403);
    const pt = page.access_token;
    let id: string;
    if (!a.media.length) {
      id = (await call<{ id: string }>(`${a.pageId}/feed`, pt, { method: "POST", json: { message: a.caption } })).id;
    } else if (a.media.length === 1 && isVideo(a.media[0])) {
      id = (await call<{ id: string }>(`${a.pageId}/videos`, pt, { method: "POST", json: { file_url: a.media[0].url, description: a.caption } })).id;
    } else if (a.media.length === 1) {
      const r = await call<{ id: string; post_id?: string }>(`${a.pageId}/photos`, pt, { method: "POST", json: { url: a.media[0].url, caption: a.caption } });
      id = r.post_id ?? r.id;
    } else {
      const attached: { media_fbid: string }[] = [];
      for (const m of a.media.filter((x) => !isVideo(x))) attached.push({ media_fbid: (await call<{ id: string }>(`${a.pageId}/photos`, pt, { method: "POST", json: { url: m.url, published: false } })).id });
      id = (await call<{ id: string }>(`${a.pageId}/feed`, pt, { method: "POST", json: { message: a.caption, attached_media: attached } })).id;
    }
    return { id, url: `https://www.facebook.com/${id}` };
  };
}

/** Links assinados (1 hora) dos arquivos de Documentos, para a Meta baixar. */
export function documentMediaUrls(sql: Sql): MediaUrls {
  return async (agencyId, ids) => {
    const store = documentsStorage();
    if (!store) throw new XodoError("O armazenamento de arquivos não está configurado.", 503);
    const docs = await sql.query<{ id: string; storage_path: string; mime: string | null }>(`select id, storage_path, mime from documents where agency_id = $1 and id = any($2::uuid[]) and status = 'ready'`, [agencyId, ids]);
    const out: Media[] = [];
    for (const id of ids) {
      const d = docs.find((x) => x.id === id);
      if (!d) throw new XodoError("Um arquivo do post foi apagado de Documentos.", 400);
      out.push({ id, url: await store.signedDownloadUrl(d.storage_path, 3600), mime: d.mime ?? "image/jpeg" });
    }
    return out;
  };
}

/** Páginas que a conexão da Meta administra, com o Instagram profissional de cada uma. */
export async function metaPages(deps: IntegrationDeps, agencyId: string, connectionId: string) {
  const token = (await access(deps, agencyId, connectionId)).accessToken;
  const r = await requestJson<{ data?: { id: string; name: string; instagram_business_account?: { id: string; username?: string } }[] }>(
    deps.fetch, `${metaGraph()}/me/accounts?fields=id,name,instagram_business_account{id,username}&limit=100`, { bearer: token });
  return (r.data ?? []).map((p) => ({ page_id: p.id, page_name: p.name, ig_user_id: p.instagram_business_account?.id ?? null, ig_username: p.instagram_business_account?.username ?? null }));
}

/** Dependências de Conteúdo no servidor. */
export async function contentDeps(sql: Sql): Promise<ContentDeps> {
  const { serverIntegrations } = await import("../integrations");
  const { mailerFromEnv } = await import("./email");
  const integrations = { sql, ...serverIntegrations() };
  return { sql, publish: metaPublisher(integrations), mediaUrls: documentMediaUrls(sql), collab: { sql, mail: mailerFromEnv(), appUrl: integrations.appUrl } };
}
