# Notas e cobranças

NFS-e das faturas e régua de cobrança. Código em `src/lib/core/fiscal.ts` (Focus NFe em
`fiscal-focus.ts`), tabelas em `supabase/migrations/20261022290000_fiscal.sql`. Só dono, admin e
financeiro (CAN_BILL).

## Configuração

- **Focus NFe**: a agência cola o token da empresa (homologação para testar, produção para valer). O
  token é conferido e fica cifrado numa conexão `focusnfe`.
- **Dados fiscais**: CNPJ e inscrição municipal da agência, município (código IBGE), código do
  serviço (LC 116, padrão 17.06), ISS, regime (Simples ou não), descrição (`{mes}` vira o mês) e o
  e-mail da contabilidade.
- **Tomador**: CPF ou CNPJ do cliente (`clients.cnpj`), razão social e e-mail de cobrança
  (`PATCH /api/clients/:id/tax`). Sem documento, a nota não sai e a tela avisa.

## Emissão

- **Quando**: quando o cliente paga, no vencimento, no dia 1º do mês ou só à mão. A regra vale para
  faturas a partir de quando foi ligada; nota cancelada não é reemitida sozinha.
- A nota vai para a prefeitura e fica "Na prefeitura" até autorizar (o cron consulta). Emitida: o PDF
  vai por e-mail para o cliente e o XML para a contabilidade (uma vez). Erro vira aviso, com o motivo.
- Cancelar pede motivo (mínimo 15 caracteres). Nota com erro pode ser descartada (a fatura volta para
  a fila).

## Régua de cobrança

E-mails com o link de pagamento 3 dias antes, no vencimento, 3 e 7 dias depois (cada um ligável).
Os de depois também avisam a equipe. Cada lembrete sai uma vez por fatura.

Ainda não: Pix Automático e pausar xodós por atraso.

## API (CAN_BILL)

- `GET /api/fiscal?agency_id=` e `PATCH /api/fiscal` (configuração).
- `POST /api/fiscal/connect`, com `{ agency_id, token, environment }`.
- `POST /api/fiscal/notes`, com `{ agency_id, invoice_ids }`; `DELETE /api/fiscal/notes/:id`, com `{ reason }`.
- `PATCH /api/clients/:id/tax`, com `{ cnpj?, legal_name?, billing_email? }`.

## Regras que valem sempre

- **Erro de rede na emissão não vira "erro".** A Focus pode ter recebido a nota; ela fica "processando" e o cron consulta pela referência. Só a recusa da prefeitura (ou do token) vira erro.
- **Cancelar uma nota com erro** consulta a Focus antes: se a prefeitura autorizou, a nota passa a "emitida" e o cancelamento precisa ser feito pela prefeitura.
- **Homologação:** nenhum e-mail sai para o cliente nem para a contabilidade; as notas são de teste.
- **Fatura que não vira nota** (cliente sem CPF/CNPJ, cadastro incompleto) gera um aviso `nota_nao_emitida` para a agência e espera um dia antes de nova tentativa.
- **Régua de cobrança** só dispara entre 8h e 20h de Brasília.
