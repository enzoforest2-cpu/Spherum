# Chamados

Código em `src/lib/core/tickets.ts`, tabelas em `supabase/migrations/20261022140000_tickets.sql`.

- **Abertura**: o cliente abre pelo portal (`POST /api/portal/cliente/collab`, `tipo: chamado`), e a
  equipe é notificada. A equipe também registra pedidos que chegaram por fora
  (`POST /api/tickets`).
- **Responsável**: se ninguém for escolhido, fica com quem cuida do cliente.
- **Prazo**: o prazo da primeira resposta depende da prioridade, em horas definidas por agência em
  `agencies.ticket_sla` (padrão: alta 2 h, média 8 h, baixa 24 h).
  - Mudar a prioridade recalcula o prazo enquanto ninguém respondeu.
  - Mudar os prazos da agência vale para os chamados abertos ainda sem resposta.
- **Primeira resposta**: é a primeira mensagem da equipe. O cliente recebe as respostas por e-mail
  e no portal.
- **Resolver**: avisa o cliente por e-mail. Uma resposta do cliente reabre o chamado.
- **Números dos últimos 30 dias**: abertos, tempo médio da primeira resposta e percentual dentro do
  prazo, no geral e por pessoa.

## API

- `GET /api/tickets?agency_id=` (CAN_READ) devolve `{ sla, tickets (com messages), stats, people }`.
- `POST /api/tickets` (CAN_USE) registra um chamado, com
  `{ agency_id, client_id, subject, priority?, text?, assignee_user? }`.
- `PATCH /api/tickets/:id` (CAN_USE) altera `{ priority?, assignee_user?, status: aberto | resolvido }`.
- `POST /api/tickets/:id/messages` (CAN_USE) responde, com `{ text }`.
- `PATCH /api/agencies/:id/ticket-sla` (CAN_MANAGE) muda os prazos, com `{ alta, media, baixa }`
  (em horas).
- No portal do cliente: `tipo: chamado` com `{ subject, text, priority? }` e `tipo: chamado_resposta`
  com `{ item_id, text }`. Os chamados chegam em `tickets` dentro de `/api/portal/cliente`.
