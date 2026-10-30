# API e webhooks

API REST (v1) e webhooks de saída para quem integra com o Spherum. Vêm no plano **Rede** e no
**Empresarial**; no **Escala**, com o add-on "API e webhooks". No teste grátis não há API. Código em
`src/lib/core/public-api.ts` (chaves e recursos) e `src/lib/core/webhooks.ts` (eventos e entregas);
tabelas em `supabase/migrations/20261030150000_public_api.sql` (só o servidor lê e grava).

Se a agência desce de plano ou tira o add-on, as chaves param de funcionar (402) e a fila de webhooks
não sai até voltar.

## Chaves de API

Criadas em Configurações → API e webhooks por quem pode **editar** "Integrações e configurações".

- A chave inteira (`sph_live_…`) aparece **uma vez**, na criação. O Spherum guarda só o sha256 e o
  prefixo visível (ex.: `sph_live_ab12`) para você reconhecer a chave na lista.
- Escopos: `read` (lê tudo abaixo) e `write` (também cria negócios e leads; inclui `read`).
- Revogar vale na hora. Se a pessoa que criou a chave sair da agência, a chave para junto.
- Até 20 chaves ativas por agência.

Rotas do app (login normal do Spherum):

- `GET /api/agencies/:id/api-keys` (ver configurações): `{ enabled, keys }` (sem a chave).
- `POST /api/agencies/:id/api-keys` (editar configurações), com `{ name, scopes?: ["read"] | ["read", "write"] }`:
  `{ key: { id, name, prefix, scopes, created_at, key } }`.
- `DELETE /api/agencies/:id/api-keys/:keyId` (editar configurações; funciona com a agência bloqueada).

## Autenticação

Toda chamada a `/api/v1/**` leva a chave no cabeçalho:

```
Authorization: Bearer sph_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

| Situação | Resposta |
| --- | --- |
| Sem chave, chave errada, revogada ou de quem saiu da agência | 401 |
| Chave só `read` tentando criar | 403 |
| Agência suspensa pelo Spherum | 403 (nada funciona) |
| API fora do plano | 402 |
| Agência bloqueada pela cobrança (teste acabou, atraso, cancelada) | lê normalmente; criar dá 402 |
| Mais de **120 pedidos por minuto** na mesma chave | 429, com `Retry-After` (segundos) |

Erros sempre vêm como JSON `{ "error": "mensagem" }`. Dados inválidos: 400.

## Convenções

- Nomes de campo em inglês snake_case, estáveis. Valores de status e etapa são os mesmos do app
  (`ativo`, `proposta`, `respondeu`…). Dinheiro em centavos (`*_cents`, inteiro). Datas `YYYY-MM-DD`;
  momentos em texto ISO com fuso.
- Listas: mais novos primeiro, com `limit` (padrão 50, máximo 100) e `cursor`. A resposta é
  `{ data, has_more, next_cursor }`; para a próxima página, mande `cursor=<next_cursor>`. O cursor é
  opaco: não monte à mão.

## Recursos

### Clientes

- `GET /api/v1/clients?status=ativo&include_archived=true&limit=&cursor=`
  Campos: `id, name, segment, status, monthly_fee_cents, started_on, website, instagram, document,
  city, owner_user_id, goal_metric, goal_value, health_score, archived_at, created_at, updated_at,
  primary_contact { name, email, phone }`.
- `GET /api/v1/clients/:id` — o cliente com `contacts [{ id, name, email, phone, role, is_primary }]`.
- `GET /api/v1/clients/:id/metrics?from=2026-10-01&to=2026-10-31` — métricas diárias somadas por dia e
  plataforma (até 366 dias; sem datas, os últimos 30): `{ client_id, from, to, data: [{ date, platform,
  spend_cents, impressions, clicks, leads, conversions, revenue_cents }] }`.

### Negócios do CRM

- `GET /api/v1/deals?stage=proposta&limit=&cursor=`
  Campos: `id, company, contact_name, email, phone, segment, website, source, value_cents, stage,
  owner_user_id, next_action, next_action_date, notes, client_id, won_at, lost_at, lost_reason,
  created_at, updated_at`.
- `POST /api/v1/deals` (`write`) com `{ company, contact_name?, email?, phone?, segment?, website?,
  source?, value_cents?, stage?, owner_user_id?, next_action?, next_action_date?, notes? }`.
  `stage` só nas etapas abertas (`novo, contato, diagnostico, proposta, negociacao`); ganhar um negócio
  é pelo app (ele cria o cliente). `source` padrão: `api`. Devolve o negócio (201).

### Leads da prospecção

- `GET /api/v1/leads?stage=respondeu&list=Site&limit=&cursor=`
  Campos: `id, list, name, company, phone, email, segment, city, website, source, origin, stage,
  last_out_at, last_in_at, deal_id, created_at, updated_at`.
- `POST /api/v1/leads` (`write`) com `{ list, consent: true, leads: [{ phone, name?, company?, email?,
  segment?, city?, website? }] }` (até 100 por pedido). Entra como origem `manual`, pelo mesmo caminho
  da importação do app: telefone conferido, repetidos ignorados e quem pediu para sair (lista de
  bloqueio) **não** entra. Resposta: `{ added, invalid, duplicates, blocked }`. `consent: true` confirma
  que os contatos podem receber mensagem (LGPD).

### Relatórios publicados

- `GET /api/v1/reports?client_id=&limit=&cursor=` — só os publicados, do mais recente:
  `id, client_id, title, period_start, period_end, body_md, published_at, created_at`.

### Exemplos

```bash
export SPHERUM_KEY=sph_live_...

# Clientes ativos, 20 por página
curl -s "https://app.spherum.com.br/api/v1/clients?status=ativo&limit=20" \
  -H "Authorization: Bearer $SPHERUM_KEY"

# Próxima página
curl -s "https://app.spherum.com.br/api/v1/clients?status=ativo&limit=20&cursor=$NEXT" \
  -H "Authorization: Bearer $SPHERUM_KEY"

# Métricas de outubro de um cliente
curl -s "https://app.spherum.com.br/api/v1/clients/$CLIENT_ID/metrics?from=2026-10-01&to=2026-10-31" \
  -H "Authorization: Bearer $SPHERUM_KEY"

# Negócio novo no CRM (chave com write)
curl -s -X POST "https://app.spherum.com.br/api/v1/deals" \
  -H "Authorization: Bearer $SPHERUM_KEY" -H "Content-Type: application/json" \
  -d '{"company":"Padaria Pão Quente","contact_name":"Ana","email":"ana@paoquente.com.br","value_cents":250000,"source":"site"}'

# Leads do formulário do site para a lista "Site"
curl -s -X POST "https://app.spherum.com.br/api/v1/leads" \
  -H "Authorization: Bearer $SPHERUM_KEY" -H "Content-Type: application/json" \
  -d '{"list":"Site","consent":true,"leads":[{"phone":"(41) 99999-0001","name":"Ana","company":"Studio Ana"}]}'
```

## Webhooks

A agência cadastra endereços **https públicos** (endereços de rede privada, `localhost` e afins são
recusados, no cadastro e de novo a cada envio) e escolhe os eventos. Até 10 por agência.

| Evento | Quando | `data` |
| --- | --- | --- |
| `client.created` | cliente novo (pelo app ou negócio ganho) | `id, name, segment, status, monthly_fee_cents, created_at` |
| `deal.won` | negócio marcado como fechado | `id, company, contact_name, email, phone, value_cents, client_id, project_id, contract_id, won_at` |
| `lead.replied` | lead da prospecção respondeu no WhatsApp (pedidos de SAIR não contam) | `id, phone, text, replied_at` |
| `invoice.paid` | fatura de cliente paga (confirmada pelo provedor ou marcada à mão) | `id, client_id, description, amount_cents, paid_cents, paid_at, method, manual, due_date` |
| `report.published` | relatório passou a publicado (pela equipe) | `id, client_id, title, period_start, period_end, published_at` |

Corpo de cada entrega (POST, `Content-Type: application/json`):

```json
{ "id": "b1c…", "type": "deal.won", "created_at": "2026-10-30T15:00:00.000Z", "agency_id": "…", "data": { … } }
```

Cabeçalhos: `X-Spherum-Event` (o tipo), `X-Spherum-Delivery` (id da entrega; igual em todas as
tentativas, use para não processar duas vezes) e `X-Spherum-Signature`.

- Resposta 2xx em até 10 s conta como entregue. Redirecionamento não é seguido.
- Senão, nova tentativa depois de 1 min, 5 min, 30 min, 2 h, 6 h e 15 h (~24 h no total); depois disso
  a entrega falha de vez. A ordem entre eventos não é garantida.
- **25 falhas seguidas** no mesmo endereço (somando eventos) desativam o endereço, cancelam o que
  estava na fila e avisam a agência. Para voltar, cadastre de novo.
- O evento entra na fila junto com a ação: se a ação for desfeita, o evento some. Uma falha na fila
  nunca impede a ação (vai só para o log).

Rotas do app:

- `GET /api/agencies/:id/webhooks` (ver configurações): `{ enabled, events, webhooks }` (com falhas
  seguidas, último erro, pendentes; sem o segredo).
- `POST /api/agencies/:id/webhooks` (editar configurações) com `{ url, events, description? }`:
  `{ endpoint, secret }` — o segredo `whsec_…` aparece **uma vez**.
- `DELETE /api/agencies/:id/webhooks/:hookId` (editar configurações).
- `POST /api/agencies/:id/webhooks/:hookId/test` (editar configurações): manda agora um evento
  `webhook.test` assinado e devolve `{ ok, status, error }` (não conta como falha).

O agendador (`/api/cron/xodos`, etapa `webhooks`) entrega a fila a cada ciclo.

### Verificar a assinatura

`X-Spherum-Signature: t=<unix>,v1=<hex>`, em que `v1` é o HMAC-SHA256, com o segredo do endereço,
de `` `${t}.${corpo}` `` — o corpo **cru**, exatamente como chegou. Recuse `t` muito antigo (ex.: mais de
5 minutos) para evitar reenvio.

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const SECRET = process.env.SPHERUM_WEBHOOK_SECRET; // whsec_…
const app = express();

app.post("/spherum", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("X-Spherum-Signature") ?? "";
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const body = req.body.toString("utf8");
  const expected = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  const ok = fresh && v1?.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  if (!ok) return res.status(400).send("assinatura inválida");

  const event = JSON.parse(body);
  // Idempotência: X-Spherum-Delivery repete nas novas tentativas.
  console.log(event.type, event.data);
  res.sendStatus(204);
});

app.listen(3000);
```
