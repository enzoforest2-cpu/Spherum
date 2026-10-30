import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { isolated, one, type Sql } from "../xodos/db";
import { XodoError } from "../xodos/errors";
import { assertPublicUrl, type Resolver } from "../xodos/net";
import { masterKeyFromEnv, openSecret, sealSecret } from "../xodos/vault";
import { audit } from "./audit";
import { apiEnabled } from "./subscription";

/**
 * Webhooks de saída: a agência cadastra endereços https e escolhe os eventos. Cada evento vira uma
 * linha na fila (webhook_deliveries) por endereço inscrito; o agendador entrega, assinando o corpo
 * com HMAC-SHA256 ("X-Spherum-Signature: t=<unix>,v1=<hex>" sobre `${t}.${body}`).
 *
 * - Falhou (erro de rede ou resposta fora de 2xx): tenta de novo com espera crescente, até ~24h.
 * - Muitas falhas seguidas no mesmo endereço: o endereço é desativado e a agência é avisada.
 * - emitEvent nunca derruba a ação principal: erro vai só para o log. Dentro de uma transação, a
 *   linha da fila sai junto com ela (se a ação desfizer, o evento também some).
 */

export const WEBHOOK_EVENTS = ["client.created", "deal.won", "lead.replied", "invoice.paid", "report.published"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Espera antes de cada nova tentativa (depois da 1ª, 2ª…): somadas, ~24h. Depois da última, a entrega falha de vez. */
export const RETRY_DELAYS_MIN = [1, 5, 30, 120, 360, 900];
export const WEBHOOK_LIMITS = { endpoints: 10, disableAfter: 25, batch: 50, timeoutMs: 10_000, keepDays: 30 };

type Fetch = typeof fetch;
type WebhookOpts = { masterKey?: string; resolve?: Resolver };

const cut = (s: string, max = 300) => s.slice(0, max);
const aadOf = (agencyId: string, id: string) => `webhook_endpoints:${agencyId}:${id}`;

/** Assinatura de um corpo: o cabeçalho X-Spherum-Signature. */
export function signWebhook(secret: string, body: string, t: number) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Gestão (tela da agência)
// ---------------------------------------------------------------------------

export const webhookInput = z.object({
  url: z.string().trim().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Escolha ao menos um evento.").max(WEBHOOK_EVENTS.length),
  description: z.string().trim().max(120).optional(),
});

async function assertApi(sql: Sql, agencyId: string) {
  if (!(await apiEnabled(sql, agencyId))) {
    throw new XodoError(`API e webhooks vêm no plano Rede (ou com o add-on "API e webhooks" no Escala). Veja em Configurações → Plano e cobrança.`, 402);
  }
}

async function checkUrl(raw: string, resolve?: Resolver) {
  let url: URL;
  try {
    url = await assertPublicUrl(raw, resolve);
  } catch (error) {
    throw new XodoError(error instanceof Error ? error.message : "Endereço inválido.", 400);
  }
  if (url.protocol !== "https:") throw new XodoError("Use um endereço https.", 400);
  return url;
}

export async function listWebhooks(sql: Sql, agencyId: string) {
  return sql.query<{ id: string; url: string; description: string | null; events: string[]; secret_hint: string; failures: number; last_success_at: string | null; last_failure_at: string | null; last_error: string | null; disabled_at: string | null; disabled_reason: string | null; created_at: string; pending: number }>(
    `select e.id, e.url, e.description, e.events, e.secret_hint, e.failures, e.last_success_at::text, e.last_failure_at::text, e.last_error,
            e.disabled_at::text, e.disabled_reason, e.created_at::text,
            (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'pendente') as pending
       from webhook_endpoints e where e.agency_id = $1 order by e.created_at desc`,
    [agencyId],
  );
}

/** Cadastra o endereço. O segredo de assinatura volta só aqui, uma vez. */
export async function createWebhook(sql: Sql, agencyId: string, userId: string, raw: unknown, opts: WebhookOpts = {}) {
  const input = webhookInput.parse(raw);
  await assertApi(sql, agencyId);
  const url = await checkUrl(input.url, opts.resolve);
  const count = await one<{ n: number }>(sql, `select count(*)::int as n from webhook_endpoints where agency_id = $1`, [agencyId]);
  if ((count?.n ?? 0) >= WEBHOOK_LIMITS.endpoints) throw new XodoError(`Limite de ${WEBHOOK_LIMITS.endpoints} webhooks por agência.`, 409);
  const id = randomUUID();
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const sealed = await sealSecret(secret, aadOf(agencyId, id), opts.masterKey ?? masterKeyFromEnv());
  const events = [...new Set(input.events)];
  await sql.query(
    `insert into webhook_endpoints (id, agency_id, url, description, events, secret_ciphertext, secret_hint, created_by)
     values ($1, $2, $3, $4, $5::text[], $6, $7, $8)`,
    [id, agencyId, url.toString(), input.description || null, events, sealed, secret.slice(-4), userId],
  );
  await audit(sql, { agencyId, actor: userId, action: "webhook_criado", targetType: "webhook", targetId: id, summary: url.host });
  const [endpoint] = (await listWebhooks(sql, agencyId)).filter((w) => w.id === id);
  return { endpoint, secret };
}

export async function deleteWebhook(sql: Sql, agencyId: string, userId: string, id: string) {
  const row = await one<{ url: string }>(sql, `delete from webhook_endpoints where id = $1 and agency_id = $2 returning url`, [id, agencyId]);
  if (!row) throw new XodoError("Webhook não encontrado.", 404);
  await audit(sql, { agencyId, actor: userId, action: "webhook_apagado", targetType: "webhook", targetId: id, summary: new URL(row.url).host });
  return { ok: true };
}

type EndpointRow = { id: string; agency_id: string; url: string; secret_ciphertext: string };

async function post(fetchImpl: Fetch, ep: EndpointRow, secret: string, msg: { id: string; type: string; body: string }, now: Date, resolve?: Resolver) {
  try {
    // Confere o endereço de novo a cada envio: o DNS pode ter passado a apontar para a rede interna.
    await assertPublicUrl(ep.url, resolve);
    const t = Math.floor(now.getTime() / 1000);
    const res = await fetchImpl(ep.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_LIMITS.timeoutMs),
      headers: {
        "content-type": "application/json",
        "user-agent": "Spherum-Webhooks/1.0",
        "x-spherum-event": msg.type,
        "x-spherum-delivery": msg.id,
        "x-spherum-signature": signWebhook(secret, msg.body, t),
      },
      body: msg.body,
    });
    await res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 300 ? { ok: true as const, status: res.status } : { ok: false as const, status: res.status, error: `Respondeu ${res.status}` };
  } catch (error) {
    return { ok: false as const, status: null, error: cut(error instanceof Error ? error.message : String(error)) };
  }
}

/** Manda agora um evento "webhook.test" assinado (não conta como falha do endereço). */
export async function testWebhook(sql: Sql, agencyId: string, id: string, fetchImpl: Fetch, now = new Date(), opts: WebhookOpts = {}) {
  await assertApi(sql, agencyId);
  const ep = await one<EndpointRow>(sql, `select id, agency_id, url, secret_ciphertext from webhook_endpoints where id = $1 and agency_id = $2`, [id, agencyId]);
  if (!ep) throw new XodoError("Webhook não encontrado.", 404);
  const secret = await openSecret(ep.secret_ciphertext, aadOf(agencyId, id), opts.masterKey ?? masterKeyFromEnv());
  const event = { id: randomUUID(), type: "webhook.test", created_at: now.toISOString(), agency_id: agencyId, data: { message: "Teste do Spherum: está funcionando." } };
  const r = await post(fetchImpl, ep, secret, { id: event.id, type: event.type, body: JSON.stringify(event) }, now, opts.resolve);
  return { ok: r.ok, status: r.status, error: r.ok ? null : r.error };
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

/**
 * Põe o evento na fila de cada endereço ativo da agência inscrito nele. Nunca lança: falha vai para
 * o log. Numa transação, roda num savepoint, para um erro aqui não estragar a transação.
 */
export async function emitEvent(sql: Sql, agencyId: string, type: WebhookEvent, payload: Record<string, unknown>, now = new Date()) {
  try {
    const event = { id: randomUUID(), type, created_at: now.toISOString(), agency_id: agencyId, data: payload };
    await isolated(sql, (sp) => sp.query(
      `insert into webhook_deliveries (endpoint_id, agency_id, event_id, event_type, body, next_at)
       select id, agency_id, $3::uuid, $2, $4, $5::timestamptz from webhook_endpoints
        where agency_id = $1 and disabled_at is null and $2 = any(events)`,
      [agencyId, type, event.id, JSON.stringify(event), now.toISOString()],
    ));
  } catch (error) {
    console.error(`[webhooks] evento ${type} não entrou na fila`, error);
  }
}

// ---------------------------------------------------------------------------
// Agendador
// ---------------------------------------------------------------------------

/**
 * Entrega o que venceu na fila. Cada lote é reservado (next_at + 5 min) antes de enviar, para dois
 * agendadores juntos não mandarem a mesma entrega; o que não der tempo volta sozinho depois da reserva.
 */
export async function webhookSweep(sql: Sql, fetchImpl: Fetch, now = new Date(), opts: { deadline?: number; limit?: number } & WebhookOpts = {}) {
  const left = () => !opts.deadline || Date.now() < opts.deadline - 15_000;
  const out = { delivered: 0, retried: 0, failed: 0, canceled: 0, disabled: 0 };
  // Faxina: minutos do limite de taxa e entregas encerradas há mais de 30 dias.
  await sql.query(`delete from api_key_hits where minute < $1::timestamptz - interval '1 hour'`, [now.toISOString()]);
  await sql.query(`delete from webhook_deliveries where status <> 'pendente' and created_at < $1::timestamptz - make_interval(days => $2)`, [now.toISOString(), WEBHOOK_LIMITS.keepDays]);
  if (!left()) return out;
  const due = await sql.query<{ id: string; endpoint_id: string; event_type: string; body: string; attempts: number }>(
    `update webhook_deliveries set next_at = $1::timestamptz + interval '5 minutes'
      where id in (select d.id from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
                    where d.status = 'pendente' and d.next_at <= $1::timestamptz and e.disabled_at is null
                    order by d.next_at limit $2 for update of d skip locked)
      returning id, endpoint_id, event_type, body, attempts`,
    [now.toISOString(), opts.limit ?? WEBHOOK_LIMITS.batch],
  );
  const master = due.length ? opts.masterKey ?? masterKeyFromEnv() : "";
  const endpoints = new Map<string, { ep: EndpointRow; secret: string | null; allowed: boolean; dead: boolean }>();
  for (const d of due) {
    if (!left()) break;
    let cur = endpoints.get(d.endpoint_id);
    if (!cur) {
      const ep = await one<EndpointRow & { suspended: boolean }>(sql,
        `select e.id, e.agency_id, e.url, e.secret_ciphertext, a.suspended_at is not null as suspended
           from webhook_endpoints e join agencies a on a.id = e.agency_id where e.id = $1`, [d.endpoint_id]);
      if (!ep) continue;
      const allowed = !ep.suspended && (await apiEnabled(sql, ep.agency_id));
      const secret = allowed ? await openSecret(ep.secret_ciphertext, aadOf(ep.agency_id, ep.id), master).catch(() => null) : null;
      cur = { ep, secret, allowed, dead: false };
      endpoints.set(d.endpoint_id, cur);
    }
    if (cur.dead) continue;
    if (!cur.allowed || !cur.secret) {
      // Agência suspensa ou sem a API no plano (ou segredo ilegível): a entrega não sai.
      await sql.query(`update webhook_deliveries set status = 'cancelada', last_error = $2 where id = $1`,
        [d.id, !cur.allowed ? "A agência está sem API e webhooks no plano (ou suspensa)." : "Segredo do webhook ilegível. Cadastre o endereço de novo."]);
      out.canceled++;
      continue;
    }
    const r = await post(fetchImpl, cur.ep, cur.secret, { id: d.id, type: d.event_type, body: d.body }, now, opts.resolve);
    const attempts = d.attempts + 1;
    if (r.ok) {
      await sql.query(`update webhook_deliveries set status = 'entregue', attempts = $2, last_status = $3, last_error = null, delivered_at = $4::timestamptz where id = $1`,
        [d.id, attempts, r.status, now.toISOString()]);
      await sql.query(`update webhook_endpoints set failures = 0, last_success_at = $2::timestamptz where id = $1`, [d.endpoint_id, now.toISOString()]);
      out.delivered++;
      continue;
    }
    const delay = RETRY_DELAYS_MIN[attempts - 1];
    if (delay == null) out.failed++;
    else out.retried++;
    await sql.query(
      `update webhook_deliveries set attempts = $2, last_status = $3, last_error = $4,
              status = case when $5::int is null then 'falhou' else 'pendente' end,
              next_at = case when $5::int is null then next_at else $6::timestamptz + make_interval(mins => $5::int) end
        where id = $1`,
      [d.id, attempts, r.status, r.error, delay ?? null, now.toISOString()],
    );
    const ep = await one<{ failures: number }>(sql,
      `update webhook_endpoints set failures = failures + 1, last_failure_at = $2::timestamptz, last_error = $3 where id = $1 returning failures`,
      [d.endpoint_id, now.toISOString(), r.error]);
    if (ep && ep.failures >= WEBHOOK_LIMITS.disableAfter) {
      await disableEndpoint(sql, cur.ep, `Desativado depois de ${ep.failures} falhas seguidas. Último erro: ${r.error}`);
      cur.dead = true;
      out.disabled++;
    }
  }
  return out;
}

async function disableEndpoint(sql: Sql, ep: EndpointRow, reason: string) {
  const row = await one(sql, `update webhook_endpoints set disabled_at = now(), disabled_reason = $2 where id = $1 and disabled_at is null returning id`, [ep.id, cut(reason)]);
  if (!row) return;
  await sql.query(`update webhook_deliveries set status = 'cancelada', last_error = 'Webhook desativado' where endpoint_id = $1 and status = 'pendente'`, [ep.id]);
  await sql.query(
    `insert into notifications (agency_id, kind, title, body, data) values ($1, 'webhook_desativado', $2, $3, jsonb_build_object('webhook_id', $4::text))`,
    [ep.agency_id, "Webhook desativado", cut(`${new URL(ep.url).host} falhou muitas vezes seguidas e parou de receber eventos. Confira o endereço e cadastre de novo em Configurações → API e webhooks.`, 1000), ep.id],
  );
}
