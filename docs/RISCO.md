# Radar de risco e NPS

Código em `src/lib/core/risk.ts`, tabelas em `supabase/migrations/20261022180000_risk_nps.sql`.

## Risco de cada cliente

A nota vai de 0 a 100 e é a soma dos pontos dos sinais do cliente:

| Sinal | Pontos |
| --- | --- |
| fatura vencida | 30 |
| desempenho mais de 25% pior que a meta | 25 |
| desempenho de 10% a 25% pior que a meta | 12 |
| contrato em aviso prévio | 40 |
| vigência do contrato vencida | 15 |
| chamado sem resposta fora do prazo | 10 cada, no máximo 2 |
| ajustes pedidos em aprovações nos últimos 30 dias | 10 |
| último NPS de 0 a 6 | 25 |
| último NPS de 7 ou 8 | 10 |

- **Faixas**: alto a partir de 60 e médio a partir de 30.
- **Receita em risco**: soma das mensalidades dos clientes em risco alto.
- **Marcar como resolvido**: grava a ação e multiplica a nota por 0,55 por 14 dias.

## NPS

- A agência pede a nota (`POST /api/risk/nps`, com `{ agency_id, client_ids, question }`). O portal
  de cada cliente mostra a pergunta até alguém responder (fica um pedido aberto por cliente).
- O cliente responde pelo portal (`tipo: nps`, com `{ score, comment? }`). A agência recebe uma
  notificação.
- **NPS da carteira**: usa a última nota de cada cliente, e é a porcentagem de promotores (9 e 10)
  menos a de detratores (0 a 6).

## API

- `POST /api/risk/handled` (CAN_USE), com `{ agency_id, client_id, note? }`.
- `POST /api/risk/nps` (CAN_USE).
- O radar chega em `risk` dentro de `/api/portal/agencia`. A pergunta aberta chega em `nps` dentro
  de `/api/portal/cliente`.
