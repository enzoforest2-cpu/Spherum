import { redactSecrets } from "../xodos/redact";
import type { ComputerStorage } from "./provider";

/**
 * Armazenamento de produção dos arquivos do computador: Supabase Storage pela API REST, num
 * bucket privado (anexos do xodó, uploads e downloads da pessoa). A chave de serviço só vai nos
 * cabeçalhos para o próprio Supabase, sem seguir redirecionamento, e nunca aparece em erro ou log.
 */

export const COMPUTER_FILES_BUCKET = "computer-files";
/** URL assinada de download: no máximo 7 dias (o padrão de uso é 1 hora). */
const MAX_SIGNED_SECONDS = 7 * 24 * 3600;

export type StorageOptions = {
  /** NEXT_PUBLIC_SUPABASE_URL (https; http só para o Supabase local). */
  url: string;
  /** SUPABASE_SERVICE_ROLE_KEY (ou a secret key nova). */
  serviceKey: string;
  bucket?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class StorageError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function baseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Endereço do Supabase inválido.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("O Supabase precisa de https.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Endereço do Supabase inválido.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Caminho do objeto no bucket, com cada parte codificada (sem "..", barra inicial ou controle). */
export function objectPath(path: string): string {
  const parts = path.split("/");
  const bad =
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    [...path].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ||
    parts.some((p) => !p || p === "." || p === "..");
  if (bad) throw new Error("Caminho de arquivo inválido no Storage.");
  return parts.map(encodeURIComponent).join("/");
}

/** Bucket do Storage (nome simples: letras minúsculas, números, - e _). */
function bucketName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(name)) throw new Error("Nome de bucket inválido.");
  return name;
}

export function supabaseStorage(o: StorageOptions): ComputerStorage {
  const base = `${baseUrl(o.url)}/storage/v1`;
  const key = o.serviceKey.trim();
  if (!key) throw new Error("Falta a chave de serviço do Supabase.");
  const bucket = bucketName(o.bucket ?? COMPUTER_FILES_BUCKET);
  const http = o.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = o.timeoutMs ?? 60_000;

  /** Mensagem do Storage sem a chave (nem outros segredos) e curta. */
  const clean = (text: string) => redactSecrets(text.split(key).join("[removido]")).text.slice(0, 200);

  async function call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
    let response: Response;
    try {
      response = await http(`${base}${path}`, {
        method,
        headers: { apikey: key, authorization: `Bearer ${key}`, ...init.headers },
        body: init.body,
        // Redirecionamento levaria a chave para outro endereço.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new StorageError(`O Storage não respondeu: ${clean(error instanceof Error ? error.message : String(error))}`, 502);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text;
      try {
        const body = JSON.parse(text) as { message?: unknown; error?: unknown };
        message = String(body.message ?? body.error ?? text);
      } catch {
        // corpo não é JSON: fica o texto
      }
      throw new StorageError(`O Storage recusou (${response.status})${message ? `: ${clean(message)}` : ""}`, response.status);
    }
    return response;
  }

  const signedPath = (value: unknown, prefix: string) => {
    if (typeof value !== "string" || !value.startsWith(prefix)) throw new StorageError("O Storage devolveu uma URL assinada inválida.", 502);
    return `${base}${value}`;
  };

  return {
    async upload(path, data, contentType) {
      await call("POST", `/object/${bucket}/${objectPath(path)}`, {
        // Cópia num ArrayBuffer próprio (o tipo de corpo do fetch não aceita qualquer visão).
        body: new Uint8Array(data),
        headers: { "content-type": contentType || "application/octet-stream", "x-upsert": "false", "cache-control": "max-age=3600" },
      });
    },
    async signedDownloadUrl(path, seconds) {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SIGNED_SECONDS) throw new Error("Validade da URL assinada inválida.");
      const response = await call("POST", `/object/sign/${bucket}/${objectPath(path)}`, {
        body: JSON.stringify({ expiresIn: seconds }),
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as { signedURL?: unknown };
      return signedPath(body.signedURL, `/object/sign/${bucket}/`);
    },
    async signedUploadUrl(path) {
      const response = await call("POST", `/object/upload/sign/${bucket}/${objectPath(path)}`, {
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as { url?: unknown };
      return signedPath(body.url, `/object/upload/sign/${bucket}/`);
    },
    async remove(path) {
      objectPath(path);
      try {
        await call("DELETE", `/object/${bucket}`, {
          body: JSON.stringify({ prefixes: [path] }),
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        // Já não existia: tudo certo.
        if (error instanceof StorageError && error.status === 404) return;
        throw error;
      }
    },
  };
}

/**
 * Armazenamento a partir do ambiente (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e,
 * opcional, COMPUTER_FILES_BUCKET). Nulo quando falta a URL ou a chave: anexos ficam desligados.
 */
export function storageFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): ComputerStorage | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return null;
  return supabaseStorage({ url, serviceKey, bucket: env.COMPUTER_FILES_BUCKET?.trim() || COMPUTER_FILES_BUCKET, fetch: fetchImpl });
}
