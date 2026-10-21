# Colaboração com o cliente

O que a agência e o cliente fazem juntos no portal do cliente. Código em `src/lib/core/collab.ts`,
tabelas em `supabase/migrations/20261021100000_client_collab.sql`. O navegador só lê (RLS); toda
escrita passa pelas rotas do servidor.

## As quatro partes

| Parte | Tabela | Quem escreve | O cliente vê |
| --- | --- | --- | --- |
| Feito pela agência | `client_updates` | equipe, xodós e o sistema | só o que está publicado |
| Pendências | `client_requests` | a agência pede, o cliente resolve | tudo menos o cancelado |
| Aprovações | `client_approvals` | a agência manda, o cliente aprova ou pede ajustes | tudo menos o cancelado |
| Mensagens | `client_messages` | os dois lados | tudo |

### Feito pela agência

- Quando um xodó pausa, retoma ou muda a verba de uma campanha, a ação vira uma atualização em
  português claro ("Ajustamos a verba diária de Leads Outubro para R$ 250,00").
- Por padrão ela entra como **rascunho**: a equipe revisa, edita o texto e publica (ou descarta).
- Com `portal_settings.auto_publicar` ligado na agência, ela já entra publicada.
- Relatório publicado (pela equipe ou pelo xodó) entra uma vez só, já publicado.
- A equipe também pode escrever atualizações à mão.

### Pendências

O tipo diz como o cliente resolve:

- `passos`: segue os passos e marca "Já fiz";
- `texto`: responde por escrito;
- `arquivo`: envia um arquivo, que vai para Documentos já compartilhado.

Quem é do cliente recebe e-mail quando a pendência é criada. A agência recebe uma notificação
quando ela é resolvida.

### Aprovações

- A agência manda um documento do cliente (ele passa a ser compartilhado) e/ou um link https.
- O cliente aprova, ou pede alterações dizendo o que mudar.
- A agência é notificada nos dois casos.

### Mensagens

- `client_message_reads` guarda até onde cada lado leu, para mostrar as não lidas.
- Mensagem da agência gera e-mail para o cliente.
- Mensagem do cliente gera notificação para a agência.

## API

Lado da agência (`CAN_USE`):

- `GET /api/clients/:id/collab` devolve tudo, rascunhos inclusive. Com `?lido=1`, marca a
  conversa como lida.
- `POST /api/clients/:id/collab` cria um item, com `{ tipo: atualizacao | pendencia | aprovacao | mensagem, ... }`.
- `PATCH /api/clients/:id/collab` muda um item, com
  `{ tipo, item_id, acao: publicar | descartar | rascunho | cancelar, title?, why? }`.
- `PATCH /api/agencies/:id/portal-settings` liga ou desliga a publicação automática, com
  `{ auto_publicar }`.

Lado do cliente (só quem é do cliente):

- `POST /api/portal/cliente/collab` recebe `{ client_id, tipo, ... }`. O `tipo` pode ser:
  - `pendencia`, com `{ item_id, response?, document_id? }`;
  - `aprovacao`, com `{ item_id, decision: aprovado | alteracoes, comment? }`;
  - `mensagem`, com `{ text }`;
  - `lido`;
  - `arquivo`, com `{ name, size, mime }`, que devolve a URL de envio;
  - `arquivo_pronto`, com `{ item_id }`, que confirma o envio.

Os dados chegam em `collab` dentro de `/api/portal/cliente` e `/api/portal/agencia`.
