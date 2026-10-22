# Chat da equipe

Conversa interna da agência. Código em `src/lib/core/team-chat.ts`, tabelas em
`supabase/migrations/20261022210000_team_chat.sql`. O navegador só lê (RLS: equipe da agência;
conversa direta só para as duas pessoas); toda escrita passa pelas rotas do servidor.

## Canais

- Toda agência ganha **#geral**, **#criação** e **#tráfego** na primeira leitura.
- **Novo canal**: o nome vira minúsculo, sem acento e com hífen (`Lançamento Verão` →
  `lancamento-verao`). Nome repetido não vale. Canal com cliente é do tipo `cliente`.
- **Conversa direta**: uma por par de pessoas da equipe, a mesma nos dois sentidos. Quem não é
  uma das duas não vê nem lê.
- **Fixar**: cada canal tem uma mensagem fixada (ou nenhuma).

## Mensagens

- Até 4.000 caracteres; a tela mostra as últimas 200.
- **Não lidas**: mensagens de outras pessoas depois da última leitura. Abrir o canal marca como
  lido; publicar também. O total aparece no menu.
- **@xodó**: citar um xodó pelo nome (`@Faísca`, sem diferença de acento ou maiúsculas) entrega a
  mensagem a ele, que trabalha em segundo plano; a resposta fica na conversa do xodó em Xodós. O
  canal recebe um aviso do Spherum. Xodó pausado não é chamado.
- **Virar tarefa**: a mensagem vira tarefa no projeto interno "Combinados da equipe" (criado na
  primeira vez), com responsável e prazo.
- A tela atualiza a cada 8 segundos enquanto está aberta.

## API

- `GET /api/team-chat?agency_id=` (CAN_READ) devolve `{ channels }` com `unread`, `other_name`
  (direta), `pinned_text` e `last_at`.
- `POST /api/team-chat` (CAN_USE) cria um canal com `{ agency_id, name, description?, client_id? }`
  ou abre a conversa direta com `{ agency_id, dm_user }`.
- `PATCH /api/team-chat/:id` (CAN_USE), com `{ pinned_text }` (null solta).
- `GET /api/team-chat/:id/messages` (CAN_READ) marca como lido; `?read=0` não marca.
- `POST /api/team-chat/:id/messages` (CAN_USE), com `{ text }`; devolve `{ message, runs }`.
- `POST /api/team-chat/:id/task` (CAN_USE), com `{ title, assignee_user?, due_date? }`.

Os canais também chegam em `teamChat` dentro de `/api/portal/agencia`.
