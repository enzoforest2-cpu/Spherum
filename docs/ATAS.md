# Atas de reunião

Código em `src/lib/core/meetings.ts`, tabelas em `supabase/migrations/20261022130000_meetings.sql`.
O navegador só lê (RLS, só a equipe da agência); toda escrita passa pelas rotas do servidor.

## Como funciona

1. **Registrar a reunião**: cliente, assunto, data, horário e participantes. A reunião fica como
   "Sem ata".
2. **Escrever a ata**: resumo, decisões e próximos passos. Há dois jeitos:
   - **à mão**, na tela;
   - **pelo xodó**: a tela manda as anotações para um xodó (`POST /api/xodos/:id/messages`), e ele
     escreve com a ferramenta `registrar_ata` (categoria rascunho). Valem os modelos, os tetos de
     gasto e as regras de aprovação de sempre.

   Nos dois casos a ata fica como rascunho para revisar.
3. **Passos**: o responsável é ligado pelo nome a alguém da equipe (nome completo ou primeiro nome,
   sem acento). Quem não é da equipe (alguém do cliente) fica só com o nome.
4. **Criar tarefas**: os passos da equipe ainda sem tarefa viram tarefas no projeto
   "Combinados · cliente", criado na primeira vez. Marcar o passo marca a tarefa. Reescrever a ata
   mantém os passos que já viraram tarefa.
5. **Enviar ao cliente**: a ata entra em "Feito pela agência" no portal (uma vez só) e, se houver
   e-mails, vai por e-mail.

## API (CAN_USE)

- `GET /api/meetings?agency_id=` lista as reuniões com os passos.
- `POST /api/meetings` registra uma reunião, com
  `{ agency_id, client_id, title, meeting_date, meeting_time?, attendees? }`.
- `PATCH /api/meetings/:id` recebe `{ acao, ... }`. A `acao` pode ser:
  - `ata`, com `{ summary, decisions?, steps?: [{ title, owner?, due_date? }], attendees? }`;
  - `passo`, com `{ step_id, done }`;
  - `tarefas`;
  - `enviar`, com `{ emails? }`.
- `DELETE /api/meetings/:id` apaga a reunião e a ata.

As reuniões também chegam em `meetings` dentro de `/api/portal/agencia`.
