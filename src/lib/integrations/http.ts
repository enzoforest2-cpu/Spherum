/**
 * Chamadas HTTP das integrações: tempo limite, JSON e um erro com a mensagem do provedor.
 * O fetch é injetável para os testes.
 */

export type Fetch = typeof fetch;

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    /** O provedor recusou o login (token vencido ou revogado): a conexão precisa ser refeita. */
    readonly reauth = false,
  ) {
    super(message);
  }
}

type RequestInit2 = Omit<RequestInit, "body"> & {
  json?: unknown;
  form?: Record<string, string>;
  /** Corpo pronto com o tipo dele (ex.: multipart do Drive). */
  raw?: { body: string; contentType: string };
  bearer?: string;
  timeoutMs?: number;
};

/** Mensagem de erro que o provedor mandou, nos formatos mais comuns (Google, Meta, Slack, GitHub, Notion). */
function providerMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 300) : null;
  const b = body as Record<string, unknown>;
  const err = b.error as Record<string, unknown> | string | undefined;
  if (typeof err === "object" && err) {
    return String(err.message ?? err.error_user_msg ?? err.status ?? JSON.stringify(err)).slice(0, 300);
  }
  return String(b.error_description ?? err ?? b.message ?? b.msg ?? "").slice(0, 300) || null;
}

async function send(http: Fetch, url: string, init: RequestInit2, accept: string): Promise<{ response: Response; text: string; parsed: unknown }> {
  const { json, form, raw, bearer, timeoutMs = 20_000, headers, ...rest } = init;
  const h = new Headers(headers);
  let body: BodyInit | undefined;
  if (json !== undefined) {
    h.set("content-type", "application/json");
    body = JSON.stringify(json);
  } else if (form) {
    h.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(form).toString();
  } else if (raw) {
    h.set("content-type", raw.contentType);
    body = raw.body;
  }
  if (bearer) h.set("authorization", `Bearer ${bearer}`);
  if (!h.has("accept")) h.set("accept", accept);

  let response: Response;
  try {
    response = await http(url, { ...rest, headers: h, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new IntegrationError(`Não consegui falar com ${new URL(url).host}: ${error instanceof Error ? error.message : error}`);
  }
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Alguns provedores respondem texto puro em erros.
  }
  // Slack responde 200 com { ok: false }.
  const slackFail = parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false;
  if (!response.ok || slackFail) {
    const message = providerMessage(parsed) ?? `HTTP ${response.status}`;
    const reauth =
      response.status === 401 || /invalid_grant|invalid_auth|token_revoked|token_expired|expired|OAuthException/i.test(message);
    throw new IntegrationError(message, response.ok ? 502 : response.status, reauth);
  }
  return { response, text, parsed };
}

export async function requestJson<T = Record<string, unknown>>(http: Fetch, url: string, init: RequestInit2 = {}): Promise<T> {
  return (await send(http, url, init, "application/json")).parsed as T;
}

/** Corpo da resposta como texto (exportação de documentos, arquivos). */
export async function requestText(http: Fetch, url: string, init: RequestInit2 = {}): Promise<string> {
  return (await send(http, url, init, "*/*")).text;
}
