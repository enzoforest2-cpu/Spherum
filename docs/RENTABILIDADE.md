# Rentabilidade

Código em `src/lib/core/profit.ts`, tabela em `supabase/migrations/20261022200000_time_entries.sql`.

## Conta de cada cliente (últimos 30 dias)

- **Receita**: a mensalidade do contrato em vigor ou, sem contrato, a do cliente.
- **Horas da equipe**: registradas por pessoa, cliente e categoria (tráfego, criativos, reuniões,
  relatórios, outros), multiplicadas pelo custo da hora da agência (`agencies.cost_per_hour`,
  padrão R$ 85).
- **Custo dos xodós**: o gasto de IA dos 30 dias, rateado entre os clientes pelas ações executadas
  com o `client_id` de cada um.
- **Margem** = mensalidade − horas − xodós.
- **Horas economizadas pelos xodós**: estimativa de 10 minutos por ação executada.

## API

- `POST /api/time` (CAN_USE) registra horas de quem chama, com
  `{ agency_id, client_id?, project_id?, category, minutes, day, note? }`. Com projeto e sem
  cliente, o cliente vem do projeto.
- `DELETE /api/time/:id` apaga um registro: o próprio, ou qualquer um para dono e admin.
- `PATCH /api/agencies/:id/cost-per-hour` (CAN_BILL) muda o custo da hora, com `{ value }`.
- O quadro chega em `profit` dentro de `/api/portal/agencia`.
