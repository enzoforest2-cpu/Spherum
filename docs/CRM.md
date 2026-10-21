# CRM

O funil de vendas da agência. Código em `src/lib/core/crm.ts`, tabela em
`supabase/migrations/20261022120000_crm.sql`. O navegador só lê (RLS, só a equipe da agência);
toda escrita passa pelas rotas do servidor.

## Etapas

`novo` → `contato` → `diagnostico` → `proposta` → `negociacao`, e fecham em `ganho` ou `perdido`.

A chance de fechar em cada etapa é usada na previsão:

| Etapa | Chance |
| --- | --- |
| novo | 10% |
| contato | 20% |
| diagnóstico | 35% |
| proposta | 50% |
| negociação | 70% |

- **Mudar de etapa** zera a contagem de dias na etapa.
- **Perdido** guarda o motivo e pode voltar para o funil.
- **Ganho** só acontece pelo "Marcar como fechado" (`POST /api/deals/:id/win`), que transforma o
  negócio em cliente:
  - cria o cliente em onboarding, com a mensalidade e o contato principal;
  - cria o projeto de onboarding pelo playbook (14 tarefas, 9 dias);
  - se houver valor e quem fechou puder cobrar (dono, admin ou financeiro), cria o contrato de 12
    meses com a mensalidade automática;
  - se o negócio tiver e-mail e quem fechou for dono ou admin, convida o contato para o portal.

  Negócio ganho não volta para o funil.
- **Contato**: "registrar contato" grava a data de hoje e a próxima ação. Negócio aberto sem
  contato há 3 dias ou mais aparece como "Sem follow-up".

## Números (últimos 90 dias)

- **Valor do funil**: soma dos valores mensais dos negócios abertos.
- **Previsão**: valor de proposta e negociação, multiplicado pela chance de cada etapa.
- **Taxa de fechamento**: ganhos divididos por ganhos + perdidos.
- **Ciclo médio**: dias da criação ao ganho.

## API (CAN_USE)

- `GET /api/deals?agency_id=` devolve `{ deals, stats }`, com `days_in_stage` em cada negócio.
- `POST /api/deals` cria um negócio, com
  `{ agency_id, company, contact_name?, email?, phone?, segment?, website?, source?, value?, stage?, owner_user?, next_action?, next_action_date?, notes? }`.
- `PATCH /api/deals/:id` altera os campos, `stage` (até `perdido`), `lost_reason`, e com
  `contacted: true` registra o contato.
- `DELETE /api/deals/:id` apaga o negócio.
- `POST /api/deals/:id/win` fecha o negócio, com `{ contract?, billing_day?, onboarding?, invite? }`.

O funil também chega em `crm` dentro de `/api/portal/agencia`.
