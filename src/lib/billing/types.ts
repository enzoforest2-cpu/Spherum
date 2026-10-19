import type { Fetch } from "../integrations/http";

/**
 * Meio de pagamento da agência. Cada provedor cria a cobrança na conta da própria agência e
 * diz o status dela. Aviso de pagamento (webhook) só serve de gatilho: o status vale quando
 * o Spherum pergunta de novo ao provedor com a chave da agência.
 */

export type ProviderId = "asaas" | "mercadopago" | "stripe" | "itau";
export type Environment = "producao" | "teste";
export type Method = "pix" | "boleto" | "cartao";
export type ChargeStatus = "pendente" | "pago" | "vencido" | "cancelado" | "estornado";

/** Credenciais como a agência cola na tela (cada provedor usa as suas). */
export type Credentials = Record<string, string>;

export type Payer = { name: string; email: string | null; document: string | null; phone: string | null };

export type ChargeInput = {
  invoiceId: string;
  amountCents: number;
  dueDate: string;
  description: string;
  methods: Method[];
  payer: Payer;
  /** Cadastro do cliente no provedor, se já existir. */
  customerId: string | null;
  /** URL para o provedor avisar mudanças (já com o token da conta). */
  notifyUrl: string;
  /** Para onde o cliente volta depois de pagar. */
  returnUrl: string;
};

export type Charge = {
  chargeId: string;
  customerId?: string;
  paymentUrl?: string | null;
  pixCode?: string | null;
  boletoLine?: string | null;
  boletoUrl?: string | null;
};

export type ChargeState = { status: ChargeStatus; paidCents?: number; paidAt?: string; method?: string };

export type ProviderCtx = { creds: Credentials; env: Environment; http: Fetch };

export interface PaymentProvider {
  id: ProviderId;
  label: string;
  /** Campos que a agência preenche ao conectar (o primeiro é a chave principal). */
  fields: { k: string; l: string; secret?: boolean; multiline?: boolean; optional?: boolean; hint?: string }[];
  /** Confere as credenciais e devolve um nome para a conta. */
  verify(ctx: ProviderCtx): Promise<{ label: string }>;
  /** Cadastra o aviso de pagamento no provedor, quando ele permite pela API. */
  registerWebhook?(ctx: ProviderCtx, url: string, token: string): Promise<string | null>;
  removeWebhook?(ctx: ProviderCtx, id: string): Promise<void>;
  createCharge(ctx: ProviderCtx, input: ChargeInput): Promise<Charge>;
  /**
   * Link para pagar agora. Quase sempre é o salvo na cobrança; o Stripe cria uma sessão nova
   * porque a dele vence em 24 h.
   */
  payUrl?(ctx: ProviderCtx, input: ChargeInput, chargeId: string): Promise<Charge>;
  status(ctx: ProviderCtx, chargeId: string, invoiceId: string): Promise<ChargeState | null>;
  cancel(ctx: ProviderCtx, chargeId: string): Promise<void>;
  /** Do corpo do aviso: o id do evento (para não repetir) e o que perguntar ao provedor. */
  parseWebhook(body: unknown, query: URLSearchParams): { eventId: string; chargeId?: string; invoiceId?: string; paymentId?: string } | null;
  /** Mercado Pago: o aviso traz o pagamento, e o pagamento diz qual fatura. */
  resolvePayment?(ctx: ProviderCtx, paymentId: string): Promise<{ invoiceId: string | null; state: ChargeState }>;
}

export const reais = (cents: number) => Math.round(cents) / 100;
