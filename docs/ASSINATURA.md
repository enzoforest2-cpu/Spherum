# Assinatura do Spherum

As agências pagam o Spherum pelo Asaas, na conta do Spherum. Código em
`src/lib/core/subscription.ts` e tabelas em `supabase/migrations/20261028100000_subscription.sql`
(e `20261030120000_subscription_fixes.sql`).
A tela fica no app da agência, em Configurações → Plano e cobrança, e no admin, em Receita.

## Como funciona

- **Teste grátis**: 14 dias, com os limites do plano Agência, sem cartão.
  - A agência escolhe plano e ciclo, e pode usar um cupom.
  - A primeira fatura começa e vence no fim do teste. Dá para pagar antes.
- **Ciclos**: mensal ou anual. O anual são 12 meses com 20% de desconto, como no site.
- **Preços**: os de tabela, que o admin muda em Configurações. O plano Empresarial só com
  preço combinado, definido pelo admin no painel da agência.
- **Add-ons**: entram em todas as faturas.
  - Os que já vêm no plano não são cobrados.
  - Os que dependem de funções que ainda não existem aparecem como "Em breve" e o servidor
    recusa: disparos com variação, domínio próprio, app com a marca, API e
    login único.
- **Cupom**: um por agência. Vale nos próximos N meses de fatura (no anual, até 12 de uma vez), em
  porcentagem ou valor fixo por mês. No anual, a porcentagem vale só sobre a parte do ano coberta
  (ex.: 3 meses de 50% dão 50% de 3/12 da fatura). Fatura cancelada sem pagar devolve os meses ao cupom.
- **Preço combinado**: vale só para o plano em que a agência está. Trocar de plano (na hora ou no
  próximo período) volta ao preço de tabela.
- **Fatura**: o servidor cria a fatura e a cobrança no Asaas. A agência paga por Pix, boleto ou
  cartão na página do Asaas, e recebe a fatura por e-mail.
- **Pagamento**: o Asaas avisa em `/api/spherum/asaas`, com o token em `asaas-access-token`.
  - O Spherum confirma o status perguntando de novo ao Asaas.
  - Fatura de período paga deixa a agência ativa até o fim do período e tira o bloqueio.
  - Fatura de um período que já acabou (paga em atraso, com a agência descoberta): o período recomeça
    no dia do pagamento. Os meses parados não são cobrados.
  - O plano e o ciclo da fatura só valem na assinatura nova ou na troca agendada. Um upgrade feito
    depois da emissão não é desfeito.
  - Estorno ou chargeback de um período pago tira esse período: o fim volta um ciclo, a agência fica
    em atraso e o bloqueio segue a carência. O agendador gera uma fatura nova desse período.
  - Fatura cancelada que mesmo assim foi paga não reativa nada: fica como crédito, com o aviso em
    Receita (coluna de erro) e na auditoria, para o admin devolver ou abater.
  - Vencida continua vencida enquanto o Asaas disser que está pendente.
  - O agendador também confere as faturas que vencem até o dia seguinte, caso algum aviso se perca.
  - Fatura em aberto sem cobrança (o Asaas falhou na hora) ganha uma no agendador; vencida, a
    cobrança nova vence hoje. O link de pagar também cria.
  - Cancelamento no Asaas que falha fica numa fila (`spherum_charge_cancels`) e o agendador tenta de
    novo. Cobrança criada para uma fatura cancelada no meio do caminho é cancelada.
- **Renovação**: a fatura do próximo período sai 5 dias antes do fim do atual, já com o plano ou o
  ciclo agendado. Não sai se a agência já tem fatura de período em aberto (ex.: reassinou em atraso).
  Troca de plano, de ciclo ou de add-on depois da emissão refaz essa fatura (e a primeira, no teste).
- **Trocas**:
  - Upgrade de plano vale na hora, com uma fatura de ajuste da diferença proporcional ao que falta
    do período.
  - Add-on novo também vale na hora, com o mesmo tipo de ajuste. Ajuste de menos de R$ 5 não é
    cobrado.
  - Plano menor e troca de ciclo valem no próximo período.
  - Tirar um add-on vale na hora, sem devolução.
  - O servidor recusa um plano ou uma redução de add-on menor que o uso atual: clientes ativos,
    pessoas com convites pendentes e xodós.
  - Clique duplo não cobra duas vezes: a troca relê o plano e os add-ons com a agência travada.
- **Cancelar**: a agência continua até o fim do período pago e não renova. A renovação já gerada e
  não paga é cancelada. "Manter assinatura" desfaz.

## Atraso e bloqueio

- **Fatura vencida** (de período ou de ajuste): a agência fica "em atraso" e recebe aviso no app e
  por e-mail. A carência é de 7 dias. Pagar a última fatura vencida tira o atraso.
- **Bloqueio**:
  - quando o teste acaba sem fatura em aberto;
  - 3 dias depois do fim do teste, se houver fatura em aberto, porque o boleto leva dias para
    compensar;
  - quando o atraso passa da carência;
  - quando a assinatura cancelada chega ao fim do período.
- **Agência bloqueada**:
  - A equipe entra e vê tudo.
  - Pode pagar, mudar de plano, mexer nos dados de cobrança e abrir chamado.
  - Não cria nem altera nada mais: as rotas respondem 402 com a explicação.
  - Param os xodós, os posts agendados, as automações, a prospecção, a busca por IA e os gatilhos
    de e-mail.
  - O portal dos clientes da agência continua aberto.
  - A cobrança e as notas fiscais dos clientes da agência continuam.
- **Aviso no topo do app**: mostra, nesta ordem, o bloqueio, a fatura vencida e o "seu teste acaba
  em X dias" (nos últimos 5 dias).
- O admin ainda pode marcar uma agência como pagante à mão, para pagamento por fora. Isso tira o
  bloqueio e o fim de período: ela não entra nas renovações, no atraso nem no bloqueio por cobrança.
  Estender o teste (de quem está em teste ou em atraso) também tira o bloqueio e o período.

## Limites do plano

| Plano | Clientes ativos | Pessoas (com convites pendentes) | Xodós |
|---|---|---|---|
| Solo | 5 | 1 | 0 |
| Agência (e o teste) | 20 | 10 | 1 |
| Escala | 100 | 30 | 3 |
| Rede | 250 | 75 | 5 |
| Empresarial | sem limite | sem limite | 10 |

Os add-ons de capacidade somam: "+5 clientes", "Pessoa a mais" e "Xodó a mais". "+50 peças" e "+10
vídeos" somam à cota do Estúdio. O servidor confere os limites ao criar um cliente, reativar um
cliente encerrado, convidar alguém para a equipe e criar um xodó.

## Configurar

1. Criar a conta do Spherum no Asaas, primeiro no sandbox.
2. Na Vercel, definir `ASAAS_SPHERUM_API_KEY`, `ASAAS_SPHERUM_ENV` (`teste` ou `producao`) e
   `ASAAS_SPHERUM_WEBHOOK_TOKEN`.
3. No Asaas, em Integrações → Webhooks, cadastrar:
   - URL: `https://spherum.com.br/api/spherum/asaas`;
   - o mesmo token;
   - os eventos de cobrança (`PAYMENT_*`).
4. Opcional: ligar no Asaas a emissão automática da nota fiscal das cobranças.

Sem a chave, assinar responde que a cobrança ainda não está configurada.

## API

- `GET /api/subscription?agency_id=` devolve plano, situação, período, faturas, add-ons, cupom, uso
  e limites. Exige ver Financeiro ou Configurações. Também vem em `/api/portal/agencia`, no campo
  `subscription`.
- `POST /api/subscription/quote` com `{ agency_id, plan, cycle?, coupon? }` devolve itens,
  desconto e total. Mesma permissão do GET.
- As rotas abaixo exigem editar Financeiro ou Configurações, e funcionam com a agência bloqueada.
  - `POST /api/subscription` com `{ agency_id, plan, cycle?, coupon?, document?, billing_email? }`
    assina ou troca de plano.
  - `PUT /api/subscription/addons` com `{ agency_id, addon, qty }`; quantidade 0 tira o add-on.
  - `POST /api/subscription/invoices/:id` com `{ agency_id }` devolve o link para pagar.
  - `PATCH /api/agencies/:id/billing` com `{ document, billing_email? }` muda os dados de cobrança.
- `POST /api/subscription/cancel` com `{ agency_id, resume? }` exige editar Equipe e Configurações.
- `POST /api/spherum/asaas` recebe o aviso do Asaas.
- Admin:
  - `POST /api/admin/invoices/:id` com `{ action: refund | cancel, reason }` estorna pelo Asaas ou
    cancela. Exige a função dono ou financeiro.
  - `PATCH /api/admin/agencies/:id` aceita `custom_price` (reais por mês, `null` volta ao preço de
    tabela).
