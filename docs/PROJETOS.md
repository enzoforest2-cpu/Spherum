# Projetos

Projetos da agência e as tarefas de cada um. Código em `src/lib/core/projects.ts`, tabelas em
`supabase/migrations/20261022100000_projects.sql`. O navegador só lê (RLS, só a equipe da
agência); toda escrita passa pelas rotas do servidor.

## Regras

- Um projeto pode ser de um cliente ou interno da agência (sem cliente).
- O responsável e quem faz cada tarefa precisam ser da equipe da agência.
- **Status**: `todo` (a fazer), `doing` (em andamento), `review` (em revisão), `done` (concluído).
  Concluir marca `done_at` e o progresso vai a 100%; voltar de concluído limpa `done_at`.
- **Progresso**: com tarefas, é a fração de tarefas feitas. Sem tarefas, a equipe informa à mão.
- **Atrasado**: o prazo já passou, no fuso da agência, e o projeto não está concluído.
- **Playbooks**: o projeto pode nascer de um playbook, que cria as tarefas com prazos contados a
  partir do início. Nenhum prazo de tarefa passa do prazo do projeto. Os playbooks são:
  - `campanha`: 8 tarefas;
  - `relatorio`: 5 tarefas;
  - `onboarding`: 14 tarefas.
- **Carga da equipe**: para cada pessoa, conta os projetos ativos de que ela é responsável e as
  tarefas abertas com ela. A capacidade na tela Equipe considera 20 tarefas abertas como 100%.

## API (CAN_USE para escrever, CAN_READ para ler)

- `GET /api/projects?agency_id=` devolve os projetos com o progresso e o atraso calculados.
- `POST /api/projects` cria um projeto, com
  `{ agency_id, name, due_date, client_id?, owner_user?, priority?, tags?, start_date?, playbook?, description? }`.
- `PATCH /api/projects/:id` altera qualquer campo, inclusive `status` e `progress`.
- `DELETE /api/projects/:id` apaga o projeto e as tarefas dele.
- `GET /api/projects/:id/tasks` lista as tarefas.
- `POST /api/projects/:id/tasks` cria uma tarefa, com `{ title, assignee_user?, due_date? }`.
- `PATCH /api/projects/:id/tasks/:taskId` altera uma tarefa, com
  `{ done?, title?, assignee_user?, due_date?, position? }`.
- `DELETE /api/projects/:id/tasks/:taskId` apaga uma tarefa.

Os projetos também chegam em `projects` dentro de `/api/portal/agencia`. A equipe vem com
`projects`, `tasks` e `cap` preenchidos.

## Na tela

- **Projetos** mostra a lista, o quadro (arrastar muda o status), a linha do tempo (45 dias, com
  hoje no 28º dia) e o calendário do mês, com os prazos dos projetos e os vencimentos das
  faturas.
- Clicar num projeto abre o painel com status, progresso, tarefas, edição e exclusão.
- O "Novo projeto" cria a partir de um projeto em branco ou de um playbook.
- No cliente, a aba Projetos lista os projetos dele.
