import { IntegrationError, requestJson } from "../../integrations/http";
import { reais, type ChargeState, type ChargeStatus, type PaymentProvider, type ProviderCtx } from "../types";

/**
 * Mercado Pago, pelo Checkout Pro: uma página de pagamento com Pix, cartão e boleto, na conta
 * da agência. O aviso traz só o id do pagamento; o pagamento diz a fatura (external_reference).
 */

const API = "https://api.mercadopago.com";
const call = <T>(ctx: ProviderCtx, path: string, init: { method?: string; json?: unknown } = {}) =>
  requestJson<T>(ctx.http, `${API}${path}`, { method: init.method ?? "GET", json: init.json, bearer: ctx.creds.access_token });

const STATUS: Record<string, ChargeStatus> = {
  approved: "pago",
  authorized: "pendente",
  pending: "pendente",
  in_process: "pendente",
  in_mediation: "pendente",
  rejected: "pendente",
  cancelled: "pendente",
  refunded: "estornado",
  charged_back: "estornado",
};

/** Data no formato que o Mercado Pago aceita (com fuso explícito, não "Z"): 2026-10-24T12:00:00.000-03:00. */
export function mpDate(d: Date): string {
  const local = new Date(d.getTime() - 3 * 3_600_000).toISOString();
  return `${local.slice(0, 23)}-03:00`;
}

type MpPayment = { id: number; status: string; external_reference?: string | null; transaction_amount: number; date_approved?: string | null; payment_type_id?: string };

function toState(p: MpPayment): ChargeState {
  const status = STATUS[p.status] ?? "pendente";
  if (status !== "pago") return { status };
  const method = p.payment_type_id === "bank_transfer" ? "pix" : p.payment_type_id === "ticket" ? "boleto" : p.payment_type_id?.includes("card") ? "cartao" : p.payment_type_id;
  return { status, paidCents: Math.round(p.transaction_amount * 100), paidAt: p.date_approved ?? undefined, method };
}

export const mercadopago: PaymentProvider = {
  id: "mercadopago",
  label: "Mercado Pago",
  fields: [{ k: "access_token", l: "Access token", secret: true, hint: "No Mercado Pago: Suas integrações → Credenciais de produção. Começa com APP_USR-." }],

  async verify(ctx) {
    const token = ctx.creds.access_token ?? "";
    if (!/^(APP_USR|TEST)-/.test(token)) throw new IntegrationError("Esse não parece um access token do Mercado Pago (começa com APP_USR- ou TEST-).", 400);
    const me = await call<{ nickname?: string; email?: string; first_name?: string }>(ctx, "/users/me");
    return { label: me.nickname || me.email || me.first_name || "Conta Mercado Pago" };
  },

  async createCharge(ctx, input) {
    const excluded = [
      ...(input.methods.includes("pix") ? [] : [{ id: "bank_transfer" }]),
      ...(input.methods.includes("boleto") ? [] : [{ id: "ticket" }]),
      ...(input.methods.includes("cartao") ? [] : [{ id: "credit_card" }, { id: "debit_card" }]),
    ];
    const pref = await call<{ id: string; init_point: string; sandbox_init_point?: string }>(ctx, "/checkout/preferences", {
      method: "POST",
      json: {
        items: [{ id: input.invoiceId, title: input.description.slice(0, 250), quantity: 1, unit_price: reais(input.amountCents), currency_id: "BRL" }],
        external_reference: input.invoiceId,
        notification_url: input.notifyUrl,
        back_urls: { success: input.returnUrl, pending: input.returnUrl, failure: input.returnUrl },
        auto_return: "approved",
        payer: { name: input.payer.name, email: input.payer.email ?? undefined },
        payment_methods: { excluded_payment_types: excluded, installments: 1 },
        statement_descriptor: undefined,
      },
    });
    return { chargeId: pref.id, paymentUrl: ctx.env === "teste" && pref.sandbox_init_point ? pref.sandbox_init_point : pref.init_point };
  },

  async status(ctx, _chargeId, invoiceId) {
    const found = await call<{ results: MpPayment[] }>(ctx, `/v1/payments/search?external_reference=${encodeURIComponent(invoiceId)}&sort=date_created&criteria=desc`);
    const states = (found.results ?? []).map(toState);
    return states.find((s) => s.status === "pago") ?? states.find((s) => s.status === "estornado") ?? { status: "pendente" };
  },

  async resolvePayment(ctx, paymentId) {
    const p = await call<MpPayment>(ctx, `/v1/payments/${encodeURIComponent(paymentId)}`);
    return { invoiceId: p.external_reference ?? null, state: toState(p) };
  },

  async cancel(ctx, chargeId) {
    // Preferência não se apaga: vence agora, e o link deixa de aceitar pagamento.
    await call(ctx, `/checkout/preferences/${encodeURIComponent(chargeId)}`, {
      method: "PUT",
      json: { expires: true, expiration_date_to: mpDate(new Date(Date.now() + 60_000)) },
    });
  },

  parseWebhook(body, query) {
    const b = body as { id?: string | number; type?: string; action?: string; data?: { id?: string | number } };
    const type = b?.type ?? query.get("type") ?? query.get("topic");
    const paymentId = b?.data?.id ?? query.get("data.id") ?? query.get("id");
    if (type !== "payment" || !paymentId) return null;
    return { eventId: `${b?.id ?? "q"}:${b?.action ?? type}:${paymentId}`, paymentId: String(paymentId) };
  },
};
