# Contratos

Contratos da agência com os clientes. Código em `src/lib/core/contracts.ts`, tabela em
`supabase/migrations/20261022110000_contracts.sql`. O navegador só lê (RLS, só a equipe da
agência); quem escreve é dono, admin ou financeiro (`CAN_BILL`), pelas rotas do servidor.

## Regras

- Um cliente tem no máximo um contrato em vigor (ativo ou em aviso prévio). Os encerrados ficam no
  histórico.
- **Cobrança**: o contrato manda na mensalidade automática (`invoice_recurrences`) ligada a ele.
  - `nova`: cria a mensalidade no dia escolhido (1 a 28). A primeira fatura é a do primeiro dia de
    cobrança a partir do início, ou de hoje se o início já passou.
  - `existente`: usa a mensalidade que o cliente já tem, e o valor passa a ser o do contrato.
  - `nenhuma`: sem cobrança automática.
- **Renovação**: nova data de fim e reajuste de 0 a 30%. O reajuste vale a partir da próxima
  mensalidade. Renovar também desfaz o aviso prévio.
- **Pausa**: dura até 90 dias e a volta é depois de hoje. Durante a pausa:
  - a cobrança segue a regra escolhida (`suspender` não gera a fatura, `metade` gera com 50% e
    "(pausa: 50%)" na descrição, `manter` gera normal);
  - os xodós não executam ações de campanha nem de portal com o `client_id` desse cliente.

  Quando a pausa acaba, ela some sozinha.
- **Aviso prévio**: guarda a data de saída. Mensalidades que vencem depois dela não são geradas, e
  no dia seguinte à saída o contrato vira encerrado.
- **Encerrar**: para a mensalidade automática na hora.
- **Situação na tela** (`state`), calculada no fuso da agência: `ativo`, `renova` (fim em até 60
  dias), `vencido` (a vigência acabou, mas a mensalidade continua até renovar ou encerrar),
  `pausado`, `aviso` e `encerrado`.

Quem aplica as regras na hora de gerar a fatura é o agendador da cobrança (`billingSweep`, no cron).

## API

- `GET /api/contracts?agency_id=` lista os contratos com `state`, `days_to_end`,
  `pause_scheduled` e `fee_now_cents`.
- `POST /api/contracts` cria um contrato, com
  `{ agency_id, client_id, monthly_fee, start_date, end_date, billing, billing_day?, document_id?, notes? }`.
- `PATCH /api/contracts/:id` recebe `{ acao, ... }`. A `acao` pode ser:
  - `renovar`, com `{ end_date, adjust_percent }`;
  - `pausar`, com `{ from, to, reason, billing }`;
  - `retomar`;
  - `aviso`, com `{ notice_end, reason? }`;
  - `cancelar_aviso`;
  - `encerrar`;
  - `editar`, com `{ monthly_fee?, document_id?, notes? }`.

Os contratos também chegam em `contracts` dentro de `/api/portal/agencia`.

## O que ainda não faz

- Assinatura digital do contrato e do aditivo de renovação. Precisa de um provedor de assinatura,
  como Clicksign ou D4Sign.
- Pausar as campanhas nas plataformas de anúncio. A pausa do contrato só impede os xodós de
  mexerem; as campanhas continuam como estão até a equipe pausar.
