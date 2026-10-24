# Cobrança dos clientes

A agência cobra os clientes dela pelo Spherum. O dinheiro cai direto na conta da agência no meio de pagamento que ela conectou; o Spherum cria a cobrança, mostra a fatura no portal do cliente e acompanha o status.

Código: `src/lib/billing/` (núcleo e um arquivo por provedor). Rotas: `src/app/api/billing/`. Banco: `supabase/migrations/20261019120000_billing.sql`. Testes: `tests/billing.test.ts`.

## Como funciona

1. **Conectar.** Em Configurações → Integrações → Recebimento dos clientes, a agência cola as credenciais do provedor. O servidor confere a chave, guarda cifrada (AES-256-GCM, a mesma chave mestra do cofre) e, quando o provedor permite, cadastra o aviso de pagamento apontando para `/api/billing/webhooks/<provedor>/<token>`. A primeira conta conectada vira a padrão; dá para trocar.
2. **Cobrar.** Em Financeiro → Nova cobrança, a fatura é gravada e vira uma cobrança no provedor padrão, com Pix, boleto e cartão (ou só uma forma). "Mensal" cria também a mensalidade automática: o agendador gera a próxima fatura 10 dias antes do vencimento, uma vez só.
3. **Pagar.** O cliente abre Financeiro no portal e clica em Pagar agora (ou copia o Pix copia e cola). O Stripe cria a página de pagamento na hora, porque a dele vence em 24 h.
4. **Confirmar.** O aviso do provedor só dispara uma nova consulta: o Spherum pergunta o status ao próprio provedor, com a chave da agência, antes de marcar como paga. Avisos repetidos são ignorados. O agendador também confere, uma vez por dia, as cobranças abertas (e as do Itaú a cada ciclo, porque ali não há aviso).

Quem pode cobrar: dono, admin e o papel **financeiro** (novo). Membros e leitores só veem. Quem é do cliente vê e paga só as faturas dele.

Sem meio de pagamento conectado, a fatura existe do mesmo jeito e pode ser marcada como paga à mão (pagamento por fora).

## Provedores

| Provedor | O que a agência cola | Formas | Aviso |
|---|---|---|---|
| **Asaas** | Chave de API (`$aact_…`), produção ou sandbox | Pix, boleto e cartão na mesma fatura (o cliente escolhe) | Cadastrado pela API, com token no cabeçalho `asaas-access-token` |
| **Mercado Pago** | Access token (`APP_USR-…`) | Pix, cartão e boleto pelo Checkout Pro | Pela `notification_url` de cada cobrança |
| **Stripe** | Chave secreta (`sk_live_…` ou `sk_test_…`; chave restrita `rk_` também serve) | Cartão; Pix e boleto se a conta Stripe liberar | Endpoint cadastrado pela API |
| **Itaú** | Client ID, client secret, chave Pix, certificado e chave privada (PEM) | Pix com vencimento (cobv) | Sem aviso: o agendador consulta |

Pontos de atenção:
- **Asaas e Itaú pedem o CPF ou CNPJ do cliente.** Cadastre no cliente antes de cobrar; sem ele, a fatura fica com o aviso "a cobrança não saiu".
- **Itaú**: as credenciais e o certificado da API Pix são pedidos ao banco. Os endereços padrão são `https://secure.api.itau/pix_recebimentos/v2` e `https://sts.itau.com.br/api/oauth/token`; se o banco informar outros, preencha os campos opcionais ao conectar. Esse provedor ainda não foi validado com uma conta Itaú real.
- **Stripe**: a fatura não tem link fixo; o link nasce quando o cliente clica em pagar.

## Variáveis

Nada novo além de `XODOS_ENCRYPTION_KEY` (cofre), `APP_URL` (endereço dos avisos e da volta do pagamento) e `CRON_SECRET` (agendador). O agendador de `/api/cron/xodos` já roda a cobrança (`billing` na resposta).

## Regras que valem sempre

- **Mensalidade não pula mês.** O ponteiro da próxima fatura só avança se ainda está onde a varredura leu (e na mesma transação da fatura). Duas varreduras ao mesmo tempo geram uma fatura só. Religar uma mensalidade parada há meses pula para o próximo vencimento, sem gerar as faturas do período parado. O dia do mês é preservado (vencimento no 31 vira 28 e fica no 28).
- **Aviso do provedor só conta depois de confirmado.** O evento é registrado em `payment_events` ao fim do tratamento; se a consulta ao provedor falhar, a repetição que o provedor manda ainda vale. Reconectar a conta mantém o token do aviso (as cobranças antigas do Mercado Pago apontam para ele).
- **Stripe:** o aviso traz o PaymentIntent e ele é consultado direto (a busca por metadados pode demorar minutos). A sessão de checkout fica guardada na fatura e é reaproveitada enquanto estiver aberta; cancelar a fatura expira a sessão.
- **Reenviar** cancela a cobrança anterior no provedor antes de criar outra. **Marcar como pago** cancela a cobrança no provedor (o boleto que já está com o cliente deixa de ser pagável).
- **Dia de Brasília:** vencido, geração da mensalidade e régua usam o calendário de Brasília, não o UTC.
- Itaú: o token de acesso fica em cache até vencer. Asaas: a data de pagamento (só dia) é guardada ao meio-dia de Brasília.
