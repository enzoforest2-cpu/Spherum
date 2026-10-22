# Retorno

Quanto cada real em anúncio virou em vendas de verdade. Código em `src/lib/core/roi.ts`, tabela em
`supabase/migrations/20261022250000_client_sales.sql`. A agência e o cliente leem (RLS); a escrita
passa pelo servidor.

## Vendas

Cada venda tem dia, valor e, se souber, o cliente final, a campanha (o `campaign_id` das métricas) e o
dia em que virou lead. Chegam de três jeitos:

- **Lançamento da equipe**, uma a uma.
- **Planilha** (CSV com data e valor; opcionais cliente, pedido e campanha). O código do pedido evita
  importar a mesma venda duas vezes. Linhas com erro voltam com o número da linha.
- **Cliente no portal** (`tipo: "venda"` em `/api/portal/cliente/collab`).

## O relatório do mês (padrão: o mês passado)

- Investimento: soma do gasto em `metrics_daily`.
- Vendas e receita: as vendas do mês. Retorno = receita ÷ investimento; custo por venda =
  investimento ÷ vendas.
- Por campanha: gasto, leads, vendas e receita das vendas ligadas a ela.
- Funil: leads (ou cliques, em loja virtual) → conversões da plataforma → vendas.
- "Ligadas a uma campanha": quantas vendas têm campanha. Ciclo médio: do lead à venda.
- O que a plataforma diz (ROAS, CPL) aparece para comparar.
- Histórico de 6 meses: investimento contra receita.
- **Publicar no portal**: vira uma atualização em "Feito pela agência" ("Retorno de setembro: cada
  R$ 1 em anúncio virou R$ 1,42 em vendas").

Na tela, tocar no cliente já escolhido abre: lançar venda, importar planilha ou ver outro mês.

Ainda não feito: ler as vendas de CRMs externos ou lojas (Shopify) e devolver as vendas para Meta e
Google como conversões offline.

## API

- `GET /api/clients/:id/roi?month=YYYY-MM` (CAN_READ).
- `POST /api/clients/:id/roi` (CAN_USE), com `{ acao: "venda", sale }`, `{ acao: "planilha", rows }` ou
  `{ acao: "publicar", month? }`.
- `DELETE /api/sales/:id` (CAN_USE).
