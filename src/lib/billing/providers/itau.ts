import { request } from "node:https";
import { IntegrationError } from "../../integrations/http";
import { reais, type ChargeState, type PaymentProvider, type ProviderCtx } from "../types";

/**
 * Itaú, pela API Pix de recebimentos (padrão do Banco Central): cobrança Pix com vencimento
 * (cobv), com Pix copia e cola. O banco exige certificado digital (mTLS) e credenciais próprias,
 * pedidas ao Itaú. Não tem aviso pela API aqui: o agendador pergunta o status das cobranças abertas.
 *
 * Os endereços padrão são os de produção do Itaú; a agência pode trocá-los ao conectar, caso o
 * banco informe outros.
 */

const DEFAULT_API = "https://secure.api.itau/pix_recebimentos/v2";
const DEFAULT_TOKEN = "https://sts.itau.com.br/api/oauth/token";

type Resp = { status: number; body: unknown };

function mtls(ctx: ProviderCtx, method: string, url: string, body: string | null, headers: Record<string, string>): Promise<Resp> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new IntegrationError("O endereço do Itaú precisa ser https.", 400);
  return new Promise((resolve, reject) => {
    const req = request(
      { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, cert: ctx.creds.cert, key: ctx.creds.key, headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body).toString() } : {}) }, timeout: 20_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try { parsed = text ? JSON.parse(text) : {}; } catch { /* texto puro */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("tempo esgotado")));
    req.on("error", (e) => reject(new IntegrationError(`Não consegui falar com o Itaú: ${e.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

function fail(r: Resp): never {
  const b = r.body as { detail?: string; title?: string; error_description?: string; message?: string };
  throw new IntegrationError(String(b?.detail ?? b?.title ?? b?.error_description ?? b?.message ?? `HTTP ${r.status}`).slice(0, 300), r.status >= 400 && r.status < 500 ? r.status : 502, r.status === 401);
}

async function token(ctx: ProviderCtx): Promise<string> {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: ctx.creds.client_id, client_secret: ctx.creds.client_secret }).toString();
  const r = await mtls(ctx, "POST", ctx.creds.token_url || DEFAULT_TOKEN, body, { "content-type": "application/x-www-form-urlencoded" });
  const t = (r.body as { access_token?: string }).access_token;
  if (r.status !== 200 || !t) fail(r);
  return t;
}

async function api(ctx: ProviderCtx, method: string, path: string, json?: unknown) {
  const t = await token(ctx);
  const r = await mtls(ctx, method, `${(ctx.creds.api_url || DEFAULT_API).replace(/\/+$/, "")}${path}`, json === undefined ? null : JSON.stringify(json), {
    authorization: `Bearer ${t}`,
    "content-type": "application/json",
    accept: "application/json",
  });
  if (r.status < 200 || r.status >= 300) fail(r);
  return r.body as Record<string, unknown>;
}

/** txid do Pix: 26 a 35 letras e números. Derivado da fatura para a mesma fatura não gerar duas cobranças. */
export function txidOf(invoiceId: string): string {
  return `sph${invoiceId.replace(/[^0-9a-f]/gi, "")}`.slice(0, 35);
}

export const itau: PaymentProvider = {
  id: "itau",
  label: "Itaú (Pix)",
  fields: [
    { k: "client_id", l: "Client ID" },
    { k: "client_secret", l: "Client secret", secret: true },
    { k: "pix_key", l: "Chave Pix que recebe", hint: "A chave Pix da conta Itaú da agência (CNPJ, e-mail, telefone ou aleatória)." },
    { k: "cert", l: "Certificado (.crt, em texto PEM)", multiline: true, secret: true, hint: "O certificado que o Itaú emitiu para a API Pix. Começa com -----BEGIN CERTIFICATE-----." },
    { k: "key", l: "Chave privada do certificado (PEM)", multiline: true, secret: true, hint: "Começa com -----BEGIN PRIVATE KEY-----. Fica cifrada no Spherum." },
    { k: "api_url", l: "Endereço da API (opcional)", optional: true, hint: `Padrão: ${DEFAULT_API}` },
    { k: "token_url", l: "Endereço do token (opcional)", optional: true, hint: `Padrão: ${DEFAULT_TOKEN}` },
  ],

  async verify(ctx) {
    for (const k of ["client_id", "client_secret", "pix_key", "cert", "key"]) if (!ctx.creds[k]?.trim()) throw new IntegrationError("Preencha todos os campos do Itaú.", 400);
    if (!/BEGIN CERTIFICATE/.test(ctx.creds.cert) || !/BEGIN (RSA |EC )?PRIVATE KEY/.test(ctx.creds.key)) throw new IntegrationError("O certificado e a chave precisam estar no formato PEM.", 400);
    if (ctx.env === "teste") throw new IntegrationError("O Itaú não tem ambiente de testes por aqui. Conecte a conta de produção.", 400);
    await token(ctx);
    return { label: `Itaú · Pix ${ctx.creds.pix_key.trim()}` };
  },

  async createCharge(ctx, input) {
    const doc = input.payer.document;
    if (!doc) throw new IntegrationError("Cadastre o CPF ou CNPJ do cliente para cobrar por Pix no Itaú.", 400);
    const txid = txidOf(input.invoiceId);
    const cob = await api(ctx, "PUT", `/cobv/${txid}`, {
      calendario: { dataDeVencimento: input.dueDate, validadeAposVencimento: 30 },
      devedor: { ...(doc.length === 14 ? { cnpj: doc } : { cpf: doc }), nome: input.payer.name.slice(0, 140) },
      valor: { original: reais(input.amountCents).toFixed(2) },
      chave: ctx.creds.pix_key.trim(),
      solicitacaoPagador: input.description.slice(0, 140),
    });
    return { chargeId: txid, pixCode: (cob.pixCopiaECola as string) ?? null };
  },

  async status(ctx, chargeId): Promise<ChargeState | null> {
    const cob = await api(ctx, "GET", `/cobv/${encodeURIComponent(chargeId)}`);
    const st = String(cob.status ?? "");
    if (st === "REMOVIDA_PELO_USUARIO_RECEBEDOR" || st === "REMOVIDA_PELO_PSP") return { status: "cancelado" };
    if (st !== "CONCLUIDA") return { status: "pendente" };
    const pix = (cob.pix as { valor?: string; horario?: string; devolucoes?: { status?: string }[] }[] | undefined)?.[0];
    if (pix?.devolucoes?.some((d) => d.status === "DEVOLVIDO")) return { status: "estornado" };
    return { status: "pago", paidCents: pix?.valor ? Math.round(Number(pix.valor) * 100) : undefined, paidAt: pix?.horario, method: "pix" };
  },

  async cancel(ctx, chargeId) {
    await api(ctx, "PATCH", `/cobv/${encodeURIComponent(chargeId)}`, { status: "REMOVIDA_PELO_USUARIO_RECEBEDOR" });
  },

  parseWebhook() {
    return null;
  },
};
