import { randomBytes } from "node:crypto";
import { z } from "zod";
import { audit } from "../core/audit";
import { IntegrationError, type Fetch } from "../integrations/http";
import { one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { lastFour, openSecret, sealSecret } from "../xodos/vault";
import { dayIn } from "../xodos/budget";
import { asaas } from "./providers/asaas";
import { itau } from "./providers/itau";
import { mercadopago } from "./providers/mercadopago";
import { stripe } from "./providers/stripe";
import type { ChargeInput, ChargeState, Credentials, Environment, Method, PaymentProvider, ProviderCtx, ProviderId } from "./types";

/**
 * Cobrança dos clientes da agência. A agência conecta a conta dela num meio de pagamento; cada
 * fatura vira uma cobrança lá, e o cliente paga pelo portal. O dinheiro vai direto para a
 * agência. Avisos do provedor só disparam uma nova consulta: o status vale quando o próprio
 * provedor confirma com a chave da agência.
 */

export const PROVIDERS: Record<ProviderId, PaymentProvider> = { asaas, mercadopago, stripe, itau };

export type BillingDeps = { sql: Sql; masterKey: string; fetch: Fetch; appUrl: string; now?: () => Date };

/** Dia de hoje em Brasília: vencimento, mensalidade e régua seguem o calendário daqui, não o UTC. */
const today = (d: Date) => dayIn("America/Sao_Paulo", d);
/** Reais → centavos sem o erro clássico de ponto flutuante (1.005 * 100 = 100.4999…). */
const toCents = (v: number) => Math.round(Number((v * 100).toFixed(4)));
/** Próximo vencimento da mensalidade: mesmo dia do mês seguinte (o dia já vem limitado a 28). */
const NEXT_DUE = `(date_trunc('month', next_due::timestamp) + interval '1 month' + (day_of_month - 1) * interval '1 day')::date`;
const aad = (agencyId: string, accountId: string) => `payment_accounts:${agencyId}:${accountId}`;

// ---------------------------------------------------------------------------
// Contas de pagamento da agência
// ---------------------------------------------------------------------------

export const connectInput = z.object({
  provider: z.enum(["asaas", "mercadopago", "stripe", "itau"]),
  environment: z.enum(["producao", "teste"]).default("producao"),
  credentials: z.record(z.string().max(40), z.string().max(20_000)),
});

const ACCOUNT_COLUMNS = `id, provider, environment, label, key_last4, is_default, status, last_error, created_at::text`;

export async function listAccounts(sql: Sql, agencyId: string) {
  return sql.query<{ id: string; provider: ProviderId; environment: Environment; label: string; key_last4: string | null; is_default: boolean; status: string; last_error: string | null; created_at: string }>(
    `select ${ACCOUNT_COLUMNS} from payment_accounts where agency_id = $1 order by is_default desc, created_at`,
    [agencyId],
  );
}

/** Confere as credenciais, guarda cifradas e cadastra o aviso de pagamento no provedor. */
export async function connectAccount(deps: BillingDeps, agencyId: string, userId: string, raw: unknown) {
  const input = connectInput.parse(raw);
  const provider = PROVIDERS[input.provider];
  const creds: Credentials = {};
  for (const f of provider.fields) {
    const v = (input.credentials[f.k] ?? "").trim();
    if (v) creds[f.k] = v;
  }
  const ctx: ProviderCtx = { creds, env: input.environment, http: deps.fetch };
  const { label } = await provider.verify(ctx);

  const existing = await one<{ id: string; webhook_id: string | null; ciphertext: string; environment: Environment; webhook_token: string | null }>(
    deps.sql,
    `select id, webhook_id, ciphertext, environment, webhook_token from payment_accounts where agency_id = $1 and provider = $2`,
    [agencyId, input.provider],
  );
  if (existing?.webhook_id && provider.removeWebhook) {
    const old = JSON.parse(await openSecret(existing.ciphertext, aad(agencyId, existing.id), deps.masterKey)) as Credentials;
    await provider.removeWebhook({ creds: old, env: existing.environment, http: deps.fetch }, existing.webhook_id);
  }
  const id = existing?.id ?? (await one<{ id: string }>(deps.sql, `select gen_random_uuid() as id`))!.id;
  // Reconectar mantém o token: as cobranças já criadas (Mercado Pago) carregam a URL de aviso com ele.
  const token = existing?.webhook_token ?? randomBytes(24).toString("hex");
  const hookUrl = `${deps.appUrl.replace(/\/+$/, "")}/api/billing/webhooks/${input.provider}/${token}`;
  let webhookId: string | null = null;
  let warning: string | null = null;
  if (provider.registerWebhook) {
    try {
      webhookId = await provider.registerWebhook(ctx, hookUrl, token);
    } catch (error) {
      // Sem o aviso, o agendador ainda confere as faturas abertas; avisa a agência.
      warning = `Não consegui cadastrar o aviso de pagamento: ${error instanceof Error ? error.message : error}`.slice(0, 300);
    }
  }
  const sealed = await sealSecret(JSON.stringify(creds), aad(agencyId, id), deps.masterKey);
  const main = creds[provider.fields[0].k] ?? "";
  await deps.sql.transaction(async (tx) => {
    const hasDefault = await one(tx, `select 1 from payment_accounts where agency_id = $1 and is_default and id <> $2`, [agencyId, id]);
    await tx.query(
      `insert into payment_accounts (id, agency_id, provider, environment, label, ciphertext, key_last4, webhook_token, webhook_id, is_default, status, last_error, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12)
       on conflict (id) do update set environment = excluded.environment, label = excluded.label, ciphertext = excluded.ciphertext, key_last4 = excluded.key_last4,
         webhook_token = excluded.webhook_token, webhook_id = excluded.webhook_id, status = 'active', last_error = excluded.last_error`,
      [id, agencyId, input.provider, input.environment, label.slice(0, 120), sealed, lastFour(main), token, webhookId, !hasDefault, warning, userId],
    );
    // Clientes cadastrados na conta antiga não valem na nova chave (pode ser outra conta).
    await tx.query(`delete from billing_customers where payment_account_id = $1`, [id]);
  });
  await audit(deps.sql, { agencyId, actor: userId, action: "pagamento_conectado", targetType: "payment_account", targetId: id, summary: input.provider });
  return { account: (await listAccounts(deps.sql, agencyId)).find((a) => a.id === id)!, warning };
}

export async function setDefaultAccount(sql: Sql, agencyId: string, accountId: string) {
  await sql.transaction(async (tx) => {
    const ok = await one(tx, `select 1 from payment_accounts where id = $1 and agency_id = $2`, [accountId, agencyId]);
    if (!ok) throw new XodoError("Conta não encontrada.", 404);
    await tx.query(`update payment_accounts set is_default = false where agency_id = $1 and is_default`, [agencyId]);
    await tx.query(`update payment_accounts set is_default = true where id = $1`, [accountId]);
  });
}

async function accountCtx(deps: BillingDeps, accountId: string) {
  const acc = await one<{ id: string; agency_id: string; provider: ProviderId; environment: Environment; ciphertext: string; webhook_id: string | null; webhook_token: string }>(
    deps.sql,
    `select id, agency_id, provider, environment, ciphertext, webhook_id, webhook_token from payment_accounts where id = $1`,
    [accountId],
  );
  if (!acc) throw new XodoError("Conta de pagamento não encontrada.", 404);
  const creds = JSON.parse(await openSecret(acc.ciphertext, aad(acc.agency_id, acc.id), deps.masterKey)) as Credentials;
  return { acc, provider: PROVIDERS[acc.provider], ctx: { creds, env: acc.environment, http: deps.fetch } as ProviderCtx };
}

export async function disconnectAccount(deps: BillingDeps, agencyId: string, userId: string, accountId: string) {
  const row = await one(deps.sql, `select 1 from payment_accounts where id = $1 and agency_id = $2`, [accountId, agencyId]);
  if (!row) throw new XodoError("Conta não encontrada.", 404);
  const { acc, provider, ctx } = await accountCtx(deps, accountId);
  if (acc.webhook_id && provider.removeWebhook) await provider.removeWebhook(ctx, acc.webhook_id).catch(() => undefined);
  await deps.sql.transaction(async (tx) => {
    const wasDefault = await one<{ is_default: boolean }>(tx, `delete from payment_accounts where id = $1 returning is_default`, [accountId]);
    if (wasDefault?.is_default) {
      await tx.query(
        `update payment_accounts set is_default = true where id = (select id from payment_accounts where agency_id = $1 order by created_at limit 1)`,
        [agencyId],
      );
    }
  });
  await audit(deps.sql, { agencyId, actor: userId, action: "pagamento_desconectado", targetType: "payment_account", targetId: accountId, summary: acc.provider });
}

// ---------------------------------------------------------------------------
// Faturas
// ---------------------------------------------------------------------------

const METHODS = ["pix", "boleto", "cartao"] as const;

export const invoiceInput = z.object({
  client_id: z.uuid(),
  description: z.string().trim().min(1).max(200),
  amount: z.number().min(1, "Valor mínimo de R$ 1,00.").max(1_000_000),
  due_date: z.iso.date(),
  methods: z.array(z.enum(METHODS)).min(1).default(["pix", "boleto", "cartao"]),
  notes: z.string().trim().max(1000).optional(),
  /** Mensal: cria também a recorrência, que gera as próximas faturas sozinha. */
  monthly: z.boolean().default(false),
});

export type InvoiceRow = {
  id: string;
  client_id: string;
  client_name: string;
  description: string;
  amount_cents: number;
  due_date: string;
  status: string;
  methods: string[];
  notes: string | null;
  provider: string | null;
  payment_url: string | null;
  pix_code: string | null;
  boleto_line: string | null;
  boleto_url: string | null;
  charge_error: string | null;
  paid_at: string | null;
  paid_cents: number | null;
  paid_method: string | null;
  paid_manually: boolean;
  recurrence_id: string | null;
  created_at: string;
};

const INVOICE_COLUMNS = `i.id, i.client_id, c.name as client_name, i.description, i.amount_cents::float8 as amount_cents, i.due_date::text, i.status, i.methods,
  i.notes, i.provider, i.payment_url, i.pix_code, i.boleto_line, i.boleto_url, i.charge_error, i.paid_at::text, i.paid_cents::float8 as paid_cents,
  i.paid_method, i.paid_manually, i.recurrence_id, i.created_at::text`;

export async function listInvoices(sql: Sql, agencyId: string, clientId?: string | null) {
  return sql.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} from invoices i join clients c on c.id = i.client_id
      where i.agency_id = $1 and ($2::uuid is null or i.client_id = $2) order by i.due_date desc, i.created_at desc limit 1000`,
    [agencyId, clientId ?? null],
  );
}

/** O que o cliente vê: as faturas dele, sem as canceladas e sem erros internos. */
export async function listClientInvoices(sql: Sql, clientId: string) {
  const rows = await sql.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} from invoices i join clients c on c.id = i.client_id
      where i.client_id = $1 and i.status <> 'cancelado' order by i.due_date desc limit 200`,
    [clientId],
  );
  return rows.map(({ charge_error: _e, notes: _n, ...r }) => (void _e, void _n, r));
}

async function getInvoice(sql: Sql, agencyId: string, id: string) {
  const row = await one<InvoiceRow>(sql, `select ${INVOICE_COLUMNS} from invoices i join clients c on c.id = i.client_id where i.id = $1 and i.agency_id = $2`, [id, agencyId]);
  if (!row) throw new XodoError("Fatura não encontrada.", 404);
  return row;
}

/** Dados do cliente que o provedor pede (nome, CPF/CNPJ, e-mail e telefone do contato principal). */
async function chargeInput(deps: BillingDeps, invoiceId: string, accountId: string): Promise<ChargeInput> {
  const r = await one<{ id: string; client_id: string; name: string; cnpj: string | null; email: string | null; phone: string | null; amount_cents: number; due_date: string; description: string; methods: Method[]; customer: string | null }>(
    deps.sql,
    `select i.id, i.client_id, c.name, c.cnpj, ct.email, ct.phone, i.amount_cents::float8 as amount_cents, i.due_date::text, i.description, i.methods,
            (select b.external_id from billing_customers b where b.client_id = c.id and b.payment_account_id = $2) as customer
       from invoices i join clients c on c.id = i.client_id
       left join lateral (select email, phone from client_contacts where client_id = c.id order by is_primary desc, created_at limit 1) ct on true
      where i.id = $1`,
    [invoiceId, accountId],
  );
  const acc = await one<{ provider: string; webhook_token: string }>(deps.sql, `select provider, webhook_token from payment_accounts where id = $1`, [accountId]);
  const app = deps.appUrl.replace(/\/+$/, "");
  return {
    invoiceId: r!.id,
    amountCents: r!.amount_cents,
    dueDate: r!.due_date,
    description: r!.description,
    methods: r!.methods,
    payer: { name: r!.name, email: r!.email, document: r!.cnpj, phone: r!.phone },
    customerId: r!.customer,
    notifyUrl: `${app}/api/billing/webhooks/${acc!.provider}/${acc!.webhook_token}`,
    returnUrl: `${app}/cliente?pagamento=${r!.id}`,
  };
}

/** Cria a cobrança no provedor. Um erro fica guardado na fatura (que continua valendo) e volta como aviso. */
export async function chargeInvoice(deps: BillingDeps, agencyId: string, invoiceId: string): Promise<string | null> {
  const account = await one<{ id: string }>(deps.sql, `select id from payment_accounts where agency_id = $1 and is_default`, [agencyId]);
  if (!account) return null;
  try {
    const { acc, provider, ctx } = await accountCtx(deps, account.id);
    const input = await chargeInput(deps, invoiceId, acc.id);
    const charge = await provider.createCharge(ctx, input);
    await deps.sql.transaction(async (tx) => {
      if (charge.customerId && charge.customerId !== input.customerId) {
        await tx.query(
          `insert into billing_customers (client_id, payment_account_id, external_id) select client_id, $2, $3 from invoices where id = $1 on conflict do nothing`,
          [invoiceId, acc.id, charge.customerId],
        );
      }
      await tx.query(
        `update invoices set payment_account_id = $2, provider = $3, provider_charge_id = $4, payment_url = $5, pix_code = $6, boleto_line = $7, boleto_url = $8, charge_error = null
          where id = $1`,
        [invoiceId, acc.id, acc.provider, charge.chargeId, charge.paymentUrl ?? null, charge.pixCode ?? null, charge.boletoLine ?? null, charge.boletoUrl ?? null],
      );
    });
    return null;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await deps.sql.query(`update invoices set charge_error = $2 where id = $1`, [invoiceId, message]);
    return message;
  }
}

export async function createInvoice(deps: BillingDeps, agencyId: string, userId: string, raw: unknown) {
  const input = invoiceInput.parse(raw);
  const client = await one(deps.sql, `select 1 from clients where id = $1 and agency_id = $2 and archived_at is null`, [input.client_id, agencyId]);
  if (!client) throw new XodoError("Cliente não encontrado.", 404);
  const cents = toCents(input.amount);
  let recurrenceId: string | null = null;
  if (input.monthly) {
    const day = Math.min(28, Number(input.due_date.slice(8, 10)));
    recurrenceId = (await one<{ id: string }>(
      deps.sql,
      `insert into invoice_recurrences (agency_id, client_id, description, amount_cents, day_of_month, methods, next_due, created_by)
       values ($1, $2, $3, $4, $5, $6, (date_trunc('month', $7::date::timestamp) + interval '1 month' + ($5::int - 1) * interval '1 day')::date, $8) returning id`,
      [agencyId, input.client_id, input.description, cents, day, input.methods, input.due_date, userId],
    ))!.id;
  }
  const row = await one<{ id: string }>(
    deps.sql,
    `insert into invoices (agency_id, client_id, description, amount_cents, due_date, methods, notes, recurrence_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [agencyId, input.client_id, input.description, cents, input.due_date, input.methods, input.notes ?? null, recurrenceId, userId],
  );
  await audit(deps.sql, { agencyId, actor: userId, action: "fatura_criada", targetType: "invoice", targetId: row!.id });
  const warning = await chargeInvoice(deps, agencyId, row!.id);
  return { invoice: await getInvoice(deps.sql, agencyId, row!.id), warning };
}

/** Cancela a cobrança da fatura no provedor (se houver). Falha vira aviso, não erro: a fatura segue o seu caminho. */
async function cancelCharge(deps: BillingDeps, invoiceId: string): Promise<string | null> {
  const acc = await one<{ payment_account_id: string | null; provider_charge_id: string | null }>(deps.sql, `select payment_account_id, provider_charge_id from invoices where id = $1`, [invoiceId]);
  if (!acc?.payment_account_id || !acc.provider_charge_id) return null;
  try {
    const { provider, ctx } = await accountCtx(deps, acc.payment_account_id);
    await provider.cancel(ctx, acc.provider_charge_id);
    return null;
  } catch (error) {
    return `Não consegui cancelar a cobrança anterior no provedor: ${error instanceof Error ? error.message : error}`.slice(0, 300);
  }
}

/** Aplica o status que o provedor confirmou. Fatura paga só volta atrás por estorno. */
async function applyState(sql: Sql, invoiceId: string, state: ChargeState) {
  if (state.status === "pago") {
    await sql.query(
      `update invoices set status = 'pago', paid_at = coalesce($2::timestamptz, paid_at, now()), paid_cents = coalesce($3, paid_cents, amount_cents), paid_method = coalesce($4, paid_method)
        where id = $1 and status in ('pendente', 'vencido')`,
      [invoiceId, state.paidAt ?? null, state.paidCents ?? null, state.method ?? null],
    );
  } else if (state.status === "estornado") {
    await sql.query(`update invoices set status = 'estornado' where id = $1 and status = 'pago'`, [invoiceId]);
  } else if (state.status === "cancelado") {
    await sql.query(`update invoices set status = 'cancelado' where id = $1 and status in ('pendente', 'vencido')`, [invoiceId]);
  } else if (state.status === "vencido") {
    await sql.query(`update invoices set status = 'vencido' where id = $1 and status = 'pendente'`, [invoiceId]);
  }
}

/** Pergunta ao provedor como está a cobrança da fatura e atualiza. */
export async function refreshInvoice(deps: BillingDeps, invoiceId: string) {
  const inv = await one<{ payment_account_id: string | null; provider_charge_id: string | null }>(
    deps.sql,
    `select payment_account_id, provider_charge_id from invoices where id = $1`,
    [invoiceId],
  );
  if (!inv?.payment_account_id || !inv.provider_charge_id) return;
  const { provider, ctx } = await accountCtx(deps, inv.payment_account_id);
  const state = await provider.status(ctx, inv.provider_charge_id, invoiceId);
  if (state) await applyState(deps.sql, invoiceId, state);
}

export const invoicePatch = z.object({ action: z.enum(["cancelar", "marcar_pago", "reenviar", "atualizar"]), paid_at: z.iso.date().optional() });

export async function updateInvoice(deps: BillingDeps, agencyId: string, userId: string, id: string, raw: unknown) {
  const input = invoicePatch.parse(raw);
  const inv = await getInvoice(deps.sql, agencyId, id);
  const open = inv.status === "pendente" || inv.status === "vencido";
  let warning: string | null = null;
  if (input.action === "cancelar") {
    if (!open) throw new XodoError("Só faturas em aberto podem ser canceladas.", 409);
    const acc = await one<{ payment_account_id: string | null; provider_charge_id: string | null }>(deps.sql, `select payment_account_id, provider_charge_id from invoices where id = $1`, [id]);
    if (acc?.payment_account_id && acc.provider_charge_id) {
      const { provider, ctx } = await accountCtx(deps, acc.payment_account_id);
      await provider.cancel(ctx, acc.provider_charge_id);
    }
    await deps.sql.query(`update invoices set status = 'cancelado' where id = $1`, [id]);
  } else if (input.action === "marcar_pago") {
    if (!open) throw new XodoError("Essa fatura não está em aberto.", 409);
    // A cobrança no provedor é cancelada para o cliente não pagar duas vezes (boleto que já está com ele).
    warning = await cancelCharge(deps, id);
    await deps.sql.query(
      `update invoices set status = 'pago', paid_manually = true, paid_at = coalesce($2::timestamptz, now()), paid_cents = amount_cents, paid_method = 'manual' where id = $1`,
      [id, input.paid_at ? `${input.paid_at}T12:00:00Z` : null],
    );
  } else if (input.action === "reenviar") {
    if (!open) throw new XodoError("Essa fatura não está em aberto.", 409);
    // Cancela a cobrança anterior antes de criar outra: senão as duas ficam pagáveis e a antiga chega como "desconhecida".
    const cancelWarning = await cancelCharge(deps, id);
    warning = (await chargeInvoice(deps, agencyId, id)) ?? cancelWarning;
  } else {
    await refreshInvoice(deps, id);
  }
  await audit(deps.sql, { agencyId, actor: userId, action: `fatura_${input.action}`, targetType: "invoice", targetId: id });
  return { invoice: await getInvoice(deps.sql, agencyId, id), warning };
}

/**
 * Link para pagar a fatura agora: para quem é do cliente (ou para a equipe conferir). O Stripe
 * cria uma sessão nova; os outros usam o link da cobrança.
 */
export async function payInvoice(deps: BillingDeps, userId: string, invoiceId: string) {
  const inv = await one<{ agency_id: string; status: string; payment_account_id: string | null; provider_charge_id: string | null; payment_url: string | null; pix_code: string | null; boleto_line: string | null; boleto_url: string | null; can: boolean }>(
    deps.sql,
    `select i.agency_id, i.status, i.payment_account_id, i.provider_charge_id, i.payment_url, i.pix_code, i.boleto_line, i.boleto_url,
            (exists (select 1 from client_portal_users u where u.client_id = i.client_id and u.user_id = $2)
             or exists (select 1 from agency_members m where m.agency_id = i.agency_id and m.user_id = $2)) as can
       from invoices i where i.id = $1`,
    [invoiceId, userId],
  );
  if (!inv || !inv.can) throw new XodoError("Fatura não encontrada.", 404);
  if (inv.status !== "pendente" && inv.status !== "vencido") throw new XodoError(inv.status === "pago" ? "Essa fatura já está paga." : "Essa fatura não está mais em aberto.", 409);
  if (!inv.payment_account_id) throw new XodoError("A agência ainda não ligou o pagamento online. Fale com ela para pagar esta fatura.", 409);
  const { provider, ctx } = await accountCtx(deps, inv.payment_account_id);
  if (provider.payUrl) {
    const charge = await provider.payUrl(ctx, await chargeInput(deps, invoiceId, inv.payment_account_id), inv.provider_charge_id ?? "");
    // Guarda a sessão aberta: o próximo clique reaproveita em vez de abrir outra sessão pagável.
    if (charge.chargeId !== inv.provider_charge_id || charge.paymentUrl !== inv.payment_url) {
      await deps.sql.query(`update invoices set provider_charge_id = $2, payment_url = $3 where id = $1`, [invoiceId, charge.chargeId, charge.paymentUrl ?? null]);
    }
    return { url: charge.paymentUrl ?? null, pix_code: null, boleto_line: null, boleto_url: null };
  }
  return { url: inv.payment_url, pix_code: inv.pix_code, boleto_line: inv.boleto_line, boleto_url: inv.boleto_url };
}

// ---------------------------------------------------------------------------
// Avisos do provedor
// ---------------------------------------------------------------------------

export async function handleWebhook(deps: BillingDeps, providerId: string, token: string, headers: Headers, body: unknown, query: URLSearchParams) {
  if (!(providerId in PROVIDERS)) throw new XodoError("Não encontrado", 404);
  const acc = await one<{ id: string; agency_id: string }>(deps.sql, `select id, agency_id from payment_accounts where provider = $1 and webhook_token = $2`, [providerId, token]);
  if (!acc) throw new XodoError("Não encontrado", 404);
  // O Asaas manda de volta o token que cadastramos.
  if (providerId === "asaas" && headers.get("asaas-access-token") !== token) throw new XodoError("Não autorizado", 401);
  const { provider, ctx } = await accountCtx(deps, acc.id);
  const ev = provider.parseWebhook(body, query);
  if (!ev) return { ignored: true };
  // O evento só é dado como tratado no fim: se a consulta ao provedor falhar, a repetição dele ainda vale.
  const seen = await one(deps.sql, `select 1 from payment_events where provider = $1 and event_id = $2`, [providerId, ev.eventId]);
  if (seen) return { duplicate: true };

  let invoiceId = ev.invoiceId ?? null;
  let state: ChargeState | null = null;
  if (ev.paymentId && provider.resolvePayment) {
    const r = await provider.resolvePayment(ctx, ev.paymentId);
    invoiceId = r.invoiceId;
    state = r.state;
  }
  const inv = invoiceId
    ? await one<{ id: string; provider_charge_id: string | null }>(deps.sql, `select id, provider_charge_id from invoices where id::text = $1 and agency_id = $2 and payment_account_id = $3`, [invoiceId, acc.agency_id, acc.id])
    : ev.chargeId
      ? await one<{ id: string; provider_charge_id: string | null }>(deps.sql, `select id, provider_charge_id from invoices where provider = $1 and provider_charge_id = $2 and payment_account_id = $3`, [providerId, ev.chargeId, acc.id])
      : null;
  const done = (invoiceId: string | null) =>
    deps.sql.query(`insert into payment_events (payment_account_id, provider, event_id, invoice_id) values ($1, $2, $3, $4) on conflict (provider, event_id) do nothing`, [acc.id, providerId, ev.eventId, invoiceId]);
  if (!inv) {
    await done(null);
    return { ignored: true };
  }
  if (!state || state.status !== "pago") state = await provider.status(ctx, inv.provider_charge_id ?? "", inv.id);
  if (state) await applyState(deps.sql, inv.id, state);
  await done(inv.id);
  return { invoice_id: inv.id, status: state?.status ?? null };
}

// ---------------------------------------------------------------------------
// Agendador: vencidas, mensalidades e conferência das cobranças sem aviso
// ---------------------------------------------------------------------------

/** Quantos dias antes do vencimento a mensalidade é gerada. */
export const GENERATE_DAYS_AHEAD = 10;

export async function billingSweep(deps: BillingDeps, opts: { deadline?: number } = {}) {
  const now = deps.now ? deps.now() : new Date();
  const left = () => !opts.deadline || Date.now() < opts.deadline - 5_000;
  const overdue = await deps.sql.query(`update invoices set status = 'vencido' where status = 'pendente' and due_date < $1::date returning id`, [today(now)]);

  // Contratos: o aviso prévio que chegou ao fim encerra o contrato e a mensalidade; a pausa que acabou some.
  const ended = await deps.sql.query<{ recurrence_id: string | null }>(
    `update client_contracts set status = 'encerrado', ended_at = now() where status = 'aviso' and notice_end < $1::date returning recurrence_id`,
    [today(now)],
  );
  for (const e of ended) if (e.recurrence_id) await deps.sql.query(`update invoice_recurrences set active = false where id = $1`, [e.recurrence_id]);
  await deps.sql.query(
    `update client_contracts set pause_from = null, pause_to = null, pause_reason = null, pause_billing = null where pause_to is not null and pause_to <= $1::date`,
    [today(now)],
  );

  let generated = 0;
  const due = await deps.sql.query<{ id: string; agency_id: string; client_id: string; description: string; amount_cents: number; methods: string[]; next_due: string; created_by: string | null }>(
    `select r.id, r.agency_id, r.client_id, r.description, r.amount_cents::float8 as amount_cents, r.methods, r.next_due::text, r.created_by
       from invoice_recurrences r join clients c on c.id = r.client_id
      where r.active and c.archived_at is null and r.next_due <= ($1::date + $2::int) order by r.next_due limit 100`,
    [today(now), GENERATE_DAYS_AHEAD],
  );
  for (const r of due) {
    if (!left()) break;
    // Avança o ponteiro só se ele ainda está onde a leitura viu: duas varreduras juntas não pulam um mês.
    const advance = (q: Sql) => one(q, `update invoice_recurrences set next_due = ${NEXT_DUE} where id = $1 and next_due = $2::date returning id`, [r.id, r.next_due]);
    // O contrato ligado à mensalidade decide: depois da saída não cobra; na pausa, suspende, cobra metade ou mantém.
    const k = await one<{ status: string; notice_end: string | null; pause_from: string | null; pause_to: string | null; pause_billing: string | null }>(
      deps.sql,
      `select status, notice_end::text, pause_from::text, pause_to::text, pause_billing from client_contracts where recurrence_id = $1 and status <> 'encerrado' limit 1`,
      [r.id],
    );
    if (k?.status === "aviso" && k.notice_end && r.next_due > k.notice_end) {
      await deps.sql.query(`update invoice_recurrences set active = false where id = $1`, [r.id]);
      continue;
    }
    const paused = !!k?.pause_from && k.pause_from <= r.next_due && r.next_due < k.pause_to!;
    const half = paused && k!.pause_billing === "metade";
    const amount = half ? Math.round(r.amount_cents / 2) : r.amount_cents;
    if ((paused && k!.pause_billing === "suspender") || amount < 100) {
      await advance(deps.sql);
      continue;
    }
    // Ponteiro e fatura na mesma transação: quem não conseguiu avançar não cria fatura.
    const made = await deps.sql.transaction(async (tx) => {
      if (!(await advance(tx))) return null;
      return one<{ id: string }>(
        tx,
        `insert into invoices (agency_id, client_id, description, amount_cents, due_date, methods, recurrence_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (recurrence_id, due_date) do nothing returning id`,
        [r.agency_id, r.client_id, half ? `${r.description} (pausa: 50%)`.slice(0, 200) : r.description, amount, r.next_due, r.methods, r.id, r.created_by],
      );
    });
    if (made) {
      generated += 1;
      await chargeInvoice(deps, r.agency_id, made.id);
    }
  }

  // Itaú não avisa por aqui: confere as abertas. Os outros também, uma vez por dia, para não perder um aviso.
  let checked = 0;
  const open = await deps.sql.query<{ id: string }>(
    `select id from invoices where status in ('pendente', 'vencido') and provider_charge_id is not null and payment_account_id is not null
        and (provider = 'itau' or updated_at < $1::timestamptz - interval '1 day')
      order by updated_at limit 40`,
    [now.toISOString()],
  );
  for (const inv of open) {
    if (!left()) break;
    try {
      await refreshInvoice(deps, inv.id);
    } catch (error) {
      // Uma fatura com problema (provedor fora, cofre, conta desconectada) não para a conferência das outras.
      if (!(error instanceof IntegrationError)) console.error("[cobranca] conferência falhou", inv.id, error);
    }
    // Marca que conferiu, para a fila andar.
    await deps.sql.query(`update invoices set updated_at = now() where id = $1`, [inv.id]);
    checked += 1;
  }
  return { overdue: overdue.length, generated, checked };
}

// ---------------------------------------------------------------------------
// Mensalidades (recorrências)
// ---------------------------------------------------------------------------

export async function listRecurrences(sql: Sql, agencyId: string) {
  return sql.query(
    `select r.id, r.client_id, c.name as client_name, r.description, r.amount_cents::float8 as amount_cents, r.day_of_month, r.methods, r.next_due::text, r.active
       from invoice_recurrences r join clients c on c.id = r.client_id where r.agency_id = $1 order by c.name`,
    [agencyId],
  );
}

export async function setRecurrenceActive(sql: Sql, agencyId: string, id: string, active: boolean, now = new Date()) {
  const row = await one<{ next_due: string; day_of_month: number }>(sql, `update invoice_recurrences set active = $3 where id = $1 and agency_id = $2 returning next_due::text, day_of_month`, [id, agencyId, active]);
  if (!row) throw new XodoError("Mensalidade não encontrada.", 404);
  // Religar depois de meses parada não gera as faturas do período parado: o ponteiro pula para o próximo vencimento.
  if (active && row.next_due < today(now)) {
    await sql.query(`update invoice_recurrences set next_due = $2::date where id = $1`, [id, nextDueFrom(today(now), row.day_of_month)]);
  }
}

/** Primeiro vencimento no dia do mês a partir de uma data (ela mesma, se cair no dia). */
export function nextDueFrom(fromDay: string, dayOfMonth: number): string {
  const [y, m] = fromDay.split("-").map(Number);
  const at = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
  const same = at(y, m);
  if (same >= fromDay) return same;
  return m === 12 ? at(y + 1, 1) : at(y, m + 1);
}

export function billingDepsFromEnv(sql: Sql, masterKey: string): BillingDeps {
  return { sql, masterKey, fetch: globalThis.fetch.bind(globalThis), appUrl: process.env.APP_URL || "https://spherum.com.br" };
}

/** Para as telas: só o que pode ir para o navegador sobre cada provedor. */
export function providerCatalog() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, fields: p.fields }));
}

