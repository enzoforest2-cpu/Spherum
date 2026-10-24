import { IntegrationError, requestJson } from "../../integrations/http";
import type { ChargeState, PaymentProvider, ProviderCtx } from "../types";

/**
 * Stripe, pelo Checkout: cartão e, se a conta da agência liberar, Pix e boleto. A sessão do
 * Checkout vence em 24 h, então o link é criado na hora em que o cliente clica em pagar. O
 * status vem dos PaymentIntents com o id da fatura nos metadados.
 */

const API = "https://api.stripe.com/v1";

/** Corpo form-encoded do Stripe (com chaves aninhadas: a[b][c]=v). */
function form(obj: Record<string, unknown>, prefix = "", out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out[key] = String(v);
  }
  return out;
}

const call = <T>(ctx: ProviderCtx, path: string, body?: Record<string, unknown>) =>
  requestJson<T>(ctx.http, `${API}${path}`, { method: body ? "POST" : "GET", form: body ? form(body) : undefined, bearer: ctx.creds.secret_key });

type Intent = { id: string; status: string; amount_received: number; created: number; metadata?: { invoice_id?: string }; payment_method_types?: string[]; latest_charge?: { refunded?: boolean; payment_method_details?: { type?: string } } | string | null };
type Session = { id: string; url: string | null; status: string; payment_status?: string; expires_at?: number; payment_intent?: Intent | string | null };

function intentState(paid: Intent): ChargeState {
  const charge = typeof paid.latest_charge === "object" ? paid.latest_charge : null;
  if (charge?.refunded) return { status: "estornado" };
  const t = charge?.payment_method_details?.type;
  return { status: "pago", paidCents: paid.amount_received, paidAt: new Date(paid.created * 1000).toISOString(), method: t === "card" ? "cartao" : t };
}

const isSession = (id: string) => id.startsWith("cs_");

export const stripe: PaymentProvider = {
  id: "stripe",
  label: "Stripe",
  fields: [{ k: "secret_key", l: "Chave secreta", secret: true, hint: "No Stripe: Desenvolvedores → Chaves de API. Começa com sk_live_ (ou sk_test_ para testes). Uma chave restrita (rk_) também serve." }],

  async verify(ctx) {
    const key = ctx.creds.secret_key ?? "";
    if (!/^(sk|rk)_(live|test)_/.test(key)) throw new IntegrationError("Essa não parece uma chave secreta do Stripe (sk_live_…).", 400);
    if ((ctx.env === "teste") !== key.includes("_test_")) throw new IntegrationError(ctx.env === "teste" ? "Para testes use a chave sk_test_." : "Para produção use a chave sk_live_.", 400);
    const acc = await call<{ settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string }; email?: string }>(ctx, "/account");
    return { label: acc.settings?.dashboard?.display_name || acc.business_profile?.name || acc.email || "Conta Stripe" };
  },

  async registerWebhook(ctx, url) {
    const hook = await call<{ id: string }>(ctx, "/webhook_endpoints", {
      url,
      description: "Spherum",
      enabled_events: { 0: "checkout.session.completed", 1: "checkout.session.async_payment_succeeded", 2: "checkout.session.async_payment_failed" },
    });
    return hook.id;
  },

  async removeWebhook(ctx, id) {
    await requestJson(ctx.http, `${API}/webhook_endpoints/${encodeURIComponent(id)}`, { method: "DELETE", bearer: ctx.creds.secret_key }).catch(() => undefined);
  },

  // Sem cobrança prévia: o link nasce no clique (payUrl).
  async createCharge(_ctx, input) {
    return { chargeId: `fatura:${input.invoiceId}` };
  },

  async payUrl(ctx, input, chargeId) {
    // Sessão ainda aberta e com mais de um minuto de validade: devolve a mesma, em vez de abrir outra pagável.
    if (isSession(chargeId)) {
      const open = await call<Session>(ctx, `/checkout/sessions/${encodeURIComponent(chargeId)}`).catch(() => null);
      if (open?.status === "open" && open.url && (open.expires_at ?? 0) * 1000 > Date.now() + 60_000) return { chargeId: open.id, paymentUrl: open.url };
    }
    const session = await call<{ id: string; url: string }>(ctx, "/checkout/sessions", {
      mode: "payment",
      success_url: input.returnUrl,
      cancel_url: input.returnUrl,
      client_reference_id: input.invoiceId,
      customer_email: input.payer.email ?? undefined,
      line_items: { 0: { quantity: 1, price_data: { currency: "brl", unit_amount: input.amountCents, product_data: { name: input.description.slice(0, 250) } } } },
      metadata: { invoice_id: input.invoiceId },
      payment_intent_data: { metadata: { invoice_id: input.invoiceId }, description: input.description.slice(0, 250) },
    });
    return { chargeId: session.id, paymentUrl: session.url };
  },

  async status(ctx, chargeId, invoiceId): Promise<ChargeState | null> {
    // A sessão guardada responde na hora; a busca por metadados demora a refletir pagamentos recentes.
    if (isSession(chargeId)) {
      const s = await call<Session>(ctx, `/checkout/sessions/${encodeURIComponent(chargeId)}?expand[]=payment_intent&expand[]=payment_intent.latest_charge`).catch(() => null);
      const pi = s && typeof s.payment_intent === "object" ? s.payment_intent : null;
      if (pi?.status === "succeeded") return intentState(pi);
    }
    const q = encodeURIComponent(`metadata['invoice_id']:'${invoiceId.replace(/[^0-9a-f-]/gi, "")}'`);
    const found = await call<{ data: Intent[] }>(ctx, `/payment_intents/search?query=${q}&expand[]=data.latest_charge`);
    const paid = (found.data ?? []).filter((i) => i.status === "succeeded").sort((a, b) => b.created - a.created)[0];
    return paid ? intentState(paid) : { status: "pendente" };
  },

  // O aviso traz o PaymentIntent: perguntar por ele é imediato, enquanto a busca por metadados pode levar minutos.
  async resolvePayment(ctx, paymentId) {
    const pi = await call<Intent>(ctx, `/payment_intents/${encodeURIComponent(paymentId)}?expand[]=latest_charge`);
    return { invoiceId: pi.metadata?.invoice_id ?? null, state: pi.status === "succeeded" ? intentState(pi) : { status: "pendente" } };
  },

  async cancel(ctx, chargeId) {
    // Expira a sessão aberta (se houver); com a fatura fechada o portal não gera link novo.
    if (isSession(chargeId)) await call(ctx, `/checkout/sessions/${encodeURIComponent(chargeId)}/expire`, {}).catch(() => undefined);
  },

  parseWebhook(body) {
    const b = body as { id?: string; type?: string; data?: { object?: { metadata?: { invoice_id?: string }; client_reference_id?: string; payment_intent?: string | null } } };
    const invoiceId = b?.data?.object?.metadata?.invoice_id ?? b?.data?.object?.client_reference_id;
    if (!b?.id || !invoiceId) return null;
    const pi = b.data?.object?.payment_intent;
    return { eventId: b.id, invoiceId, paymentId: typeof pi === "string" ? pi : undefined };
  },
};
