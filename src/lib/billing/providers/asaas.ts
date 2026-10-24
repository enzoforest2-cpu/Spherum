import { IntegrationError, requestJson } from "../../integrations/http";
import { reais, type ChargeState, type ChargeStatus, type PaymentProvider, type ProviderCtx } from "../types";

/**
 * Asaas (https://docs.asaas.com): Pix, boleto e cartão numa fatura só. Com billingType
 * UNDEFINED o cliente escolhe a forma na página da fatura, entre as liberadas na conta.
 */

const base = (ctx: ProviderCtx) => (ctx.env === "teste" ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3");
const headers = (ctx: ProviderCtx) => ({ access_token: ctx.creds.api_key, "user-agent": "Spherum" });
const call = <T>(ctx: ProviderCtx, path: string, init: { method?: string; json?: unknown } = {}) =>
  requestJson<T>(ctx.http, `${base(ctx)}${path}`, { method: init.method ?? "GET", json: init.json, headers: headers(ctx) });

const STATUS: Record<string, ChargeStatus> = {
  PENDING: "pendente",
  AWAITING_RISK_ANALYSIS: "pendente",
  RECEIVED: "pago",
  CONFIRMED: "pago",
  RECEIVED_IN_CASH: "pago",
  OVERDUE: "vencido",
  REFUNDED: "estornado",
  REFUND_REQUESTED: "estornado",
  REFUND_IN_PROGRESS: "estornado",
  CHARGEBACK_REQUESTED: "estornado",
  CHARGEBACK_DISPUTE: "estornado",
};

type AsaasPayment = { id: string; status: string; deleted?: boolean; value: number; netValue?: number; paymentDate?: string; clientPaymentDate?: string; confirmedDate?: string; billingType?: string; invoiceUrl?: string; bankSlipUrl?: string };

const EVENTS = ["PAYMENT_CREATED", "PAYMENT_UPDATED", "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_DELETED", "PAYMENT_REFUNDED", "PAYMENT_RECEIVED_IN_CASH_UNDONE", "PAYMENT_CHARGEBACK_REQUESTED"];

export const asaas: PaymentProvider = {
  id: "asaas",
  label: "Asaas",
  fields: [{ k: "api_key", l: "Chave de API", secret: true, hint: "No Asaas: Integrações → Chave de API. Começa com $aact_." }],

  async verify(ctx) {
    if (!/^\$?aact_/.test(ctx.creds.api_key ?? "")) throw new IntegrationError("Essa não parece uma chave de API do Asaas (começa com $aact_).", 400);
    const me = await call<{ name?: string; email?: string; company?: string }>(ctx, "/myAccount");
    return { label: me.company || me.name || me.email || "Conta Asaas" };
  },

  async registerWebhook(ctx, url, token) {
    const hook = await call<{ id: string }>(ctx, "/webhooks", {
      method: "POST",
      json: { name: "Spherum", url, enabled: true, interrupted: false, apiVersion: 3, authToken: token, sendType: "SEQUENTIALLY", events: EVENTS },
    });
    return hook.id;
  },

  async removeWebhook(ctx, id) {
    await call(ctx, `/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
  },

  async createCharge(ctx, input) {
    let customerId = input.customerId;
    if (!customerId) {
      if (!input.payer.document) throw new IntegrationError("Cadastre o CPF ou CNPJ do cliente para cobrar pelo Asaas.", 400);
      const customer = await call<{ id: string }>(ctx, "/customers", {
        method: "POST",
        json: { name: input.payer.name, cpfCnpj: input.payer.document, email: input.payer.email ?? undefined, mobilePhone: input.payer.phone ?? undefined, notificationDisabled: true },
      });
      customerId = customer.id;
    }
    const only = input.methods.length === 1 ? { pix: "PIX", boleto: "BOLETO", cartao: "CREDIT_CARD" }[input.methods[0]] : "UNDEFINED";
    const payment = await call<AsaasPayment>(ctx, "/payments", {
      method: "POST",
      json: { customer: customerId, billingType: only, value: reais(input.amountCents), dueDate: input.dueDate, description: input.description.slice(0, 500), externalReference: input.invoiceId },
    });
    // Pix copia e cola e linha digitável: só existem conforme a forma liberada; sem eles a fatura do Asaas resolve.
    const [pix, line] = await Promise.all([
      input.methods.includes("pix") ? call<{ payload?: string }>(ctx, `/payments/${payment.id}/pixQrCode`).catch(() => null) : null,
      input.methods.includes("boleto") ? call<{ identificationField?: string }>(ctx, `/payments/${payment.id}/identificationField`).catch(() => null) : null,
    ]);
    return { chargeId: payment.id, customerId, paymentUrl: payment.invoiceUrl ?? null, pixCode: pix?.payload ?? null, boletoLine: line?.identificationField ?? null, boletoUrl: payment.bankSlipUrl ?? null };
  },

  async status(ctx, chargeId): Promise<ChargeState | null> {
    const p = await call<AsaasPayment>(ctx, `/payments/${encodeURIComponent(chargeId)}`);
    if (p.deleted) return { status: "cancelado" };
    const status = STATUS[p.status] ?? "pendente";
    if (status !== "pago") return { status };
    const method = p.billingType === "PIX" ? "pix" : p.billingType === "BOLETO" ? "boleto" : p.billingType === "CREDIT_CARD" ? "cartao" : p.billingType?.toLowerCase();
    const when = p.clientPaymentDate ?? p.paymentDate ?? p.confirmedDate;
    // O Asaas manda só a data; ao meio-dia de Brasília ela fica no dia certo em qualquer tela.
    return { status, paidCents: Math.round(p.value * 100), paidAt: when && /^\d{4}-\d{2}-\d{2}$/.test(when) ? `${when}T12:00:00-03:00` : when, method };
  },

  async cancel(ctx, chargeId) {
    await call(ctx, `/payments/${encodeURIComponent(chargeId)}`, { method: "DELETE" });
  },

  parseWebhook(body) {
    const b = body as { id?: string; event?: string; payment?: { id?: string; externalReference?: string } };
    if (!b?.payment?.id) return null;
    return { eventId: b.id ?? `${b.event}:${b.payment.id}:${Date.now()}`, chargeId: b.payment.id };
  },
};
