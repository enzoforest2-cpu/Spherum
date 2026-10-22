# DRE

Código em `src/lib/core/dre.ts`, tabela em `supabase/migrations/20261022190000_finance_entries.sql`.

## Como o mês é montado

- **Receita**:
  - faturas pagas no mês (pela data de pagamento, no fuso de São Paulo), separadas entre
    mensalidades (com recorrência) e avulsas;
  - outras receitas lançadas.
- **Impostos**: alíquota da agência sobre a receita bruta (`agencies.dre_tax_pct`, padrão 6%).
- **Despesas**:
  - lançamentos fixos e variáveis. Um lançamento recorrente vale de `month` até `ended_month`;
  - o custo dos xodós (IA e computador na nuvem), que entra sozinho como despesa variável "Xodó".
- **Contas**:
  - receita líquida = bruta − impostos;
  - margem de contribuição = líquida − variáveis;
  - resultado = margem − fixas.
- **Apagar um lançamento recorrente**: com `?from=AAAA-MM`, ele para de repetir a partir daquele
  mês; sem `from`, some de todos os meses.

O Financeiro usa o mês atual do DRE no card "Despesas" e na lista de despesas.

## API (CAN_BILL: dono, admin, financeiro)

- `GET /api/finance/entries?agency_id=&months=` devolve o DRE dos últimos meses.
- `POST /api/finance/entries` lança, com
  `{ agency_id, kind: fixa | variavel | receita, category, description, amount, month: AAAA-MM, recurring?, client_id? }`.
- `DELETE /api/finance/entries/:id[?from=AAAA-MM]` apaga ou para a repetição.
- `PATCH /api/agencies/:id/dre-tax` muda a alíquota, com `{ pct }`.
- O DRE dos últimos 3 meses chega em `dre` dentro de `/api/portal/agencia`.
