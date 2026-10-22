# Propostas

Código em `src/lib/core/proposals.ts`, tabela em `supabase/migrations/20261022150000_proposals.sql`,
página pública em `src/app/proposta/[token]`.

## Como funciona

- **Editor**: o editor da tela (itens do catálogo, condições, aparência, aditivos) guarda o
  documento inteiro em `doc` e salva sozinho. O servidor guarda à parte a mensalidade, o valor único
  e o prazo, para os números e para o contrato.
- **Negócio**: proposta criada a partir de um negócio do CRM leva o negócio para a etapa
  "proposta".
- **Enviar**: gera um link público `/proposta/<token>`, válido por N dias. Cada envio troca o link;
  só o hash do token fica no banco. Se a proposta tiver e-mail, o link vai por e-mail.
- **Visualizações**: o link conta cada visualização. A primeira avisa a agência.
- **Aceite eletrônico**: grava nome, e-mail, data/hora e IP de quem aceitou.
  - Se a proposta veio de um negócio: o negócio é ganho (cliente, onboarding e contrato, pelo CRM),
    com o valor da proposta.
  - Se não: cria o cliente (ou usa o informado) e o contrato pelo prazo da proposta, com vencimento
    no dia de pagamento combinado.
- **Recusa**: o cliente pode recusar e dizer o motivo. A agência é avisada.
- **Proposta vencida**: passada a validade, não aceita mais.
- **Proposta aceita**: não muda mais, exceto o documento (aditivos), e não pode ser apagada.
- **Números dos últimos 90 dias**: taxa de aceite e dias até aceitar.

## API

- `GET /api/proposals?agency_id=` devolve `{ proposals, catalog, stats }`.
- `POST /api/proposals` cria uma proposta, com
  `{ agency_id, company, contact_name?, email?, phone?, source?, deal_id?, client_id?, doc, monthly_cents, one_time_cents, term_months }`.
- `PATCH /api/proposals/:id` altera a proposta. `DELETE /api/proposals/:id` apaga.
- `POST /api/proposals/:id/send` envia, com `{ valid_days, email? }`, e devolve `{ link, valid_until, emailed }`.
- `PATCH /api/agencies/:id/proposal-catalog` (CAN_MANAGE) salva o catálogo de serviços, com `{ catalog }`.
- Rotas públicas, sem login:
  - `GET /api/public/proposals/:token`;
  - `POST .../accept`, com `{ name, email, agree: true }`;
  - `POST .../decline`, com `{ reason? }`.

## O que ainda não faz

- Assinatura digital com certificado (Clicksign, D4Sign). Hoje o registro é o aceite eletrônico.
- Envio pelo WhatsApp.
- PDF da proposta (a tela baixa um HTML simples).
