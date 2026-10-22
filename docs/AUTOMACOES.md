# Automações

Gatilho → condições, esperas e ações, em ordem. Código em `src/lib/core/automations.ts` (dependências
de servidor em `automations-deps.ts`), tabelas em `supabase/migrations/20261022280000_automations.sql`.
O navegador só lê (RLS); o cron roda tudo.

## Gatilhos (lidos pelo cron nos módulos)

| Gatilho | Quando dispara |
| --- | --- |
| `formulario` | resposta de formulário (opcional: um formulário só) |
| `reuniao` | reunião marcada em Agendamentos (opcional: um tipo só) |
| `etapa_crm` | negócio chega na etapa escolhida |
| `fatura_vence` | fatura pendente a N dias do vencimento |
| `relatorio_publicado` | relatório publicado |

Ligar uma automação vale para o que acontecer **a partir dali** (não dispara o passado). Cada evento
dispara uma vez só por automação.

## Passos

- **Condições** (falsa encerra a execução como "parou na condição"): valor mínimo, tem WhatsApp,
  fatura ainda em aberto, reunião continua marcada, negócio em tal etapa.
- **Esperas**: um tempo, ou até X antes do evento (da reunião ou do vencimento; se já passou, segue).
- **Ações**: e-mail (para o lead ou para a direção), WhatsApp (modelo aprovado pela Meta; respeita
  quem pediu para sair na Prospecção), criar tarefa (no projeto "Tarefas das automações"), aviso para
  a equipe, pesquisa de NPS (portal do cliente), pedido a um xodó e mover o negócio no CRM.
- Textos aceitam `{nome}`, `{empresa}`, `{cliente}`, `{email}`, `{telefone}`, `{data}`, `{hora}`,
  `{link}` (Meet ou pagamento), `{valor}`, `{reuniao}`, `{relatorio}` e `{formulario}`.
- Erro numa ação encerra a execução como "falhou", com o motivo no registro.

"Testar agora" percorre os passos com o último evento real (ou um exemplo) **sem enviar nada**.

## API

- `GET /api/automations?agency_id=` (CAN_READ): `{ automations, runs, triggers }`.
- `POST /api/automations` (CAN_USE), com `{ agency_id, name, trigger, steps? }`.
- `PATCH /api/automations/:id` (CAN_USE), com `{ acao: "editar", automation }`, `{ acao: "ligar", on }` ou `{ acao: "testar" }`.
- `DELETE /api/automations/:id` (CAN_USE).
