# Academy

Treinamento e processos da equipe. Código em `src/lib/core/academy.ts`, tabelas em
`supabase/migrations/20261022260000_academy.sql`. O navegador só lê (RLS); a escrita passa pelo servidor.

- **Trilhas**: aulas em ordem (título, duração, link opcional). Cada pessoa marca as próprias aulas;
  a trilha mostra quem está fazendo e quanto já fez. "Atribuir" põe a trilha para alguém, com prazo,
  e manda um aviso para a pessoa.
- **Processos**: passo a passo da agência, cada passo com responsável. "Usar como checklist" cria um
  projeto (do cliente escolhido ou interno) com uma tarefa por passo, todas com o prazo final.
- **Onboarding de colaborador**: lista por fase (antes do 1º dia, semana 1, primeiros 30 dias) com
  responsáveis; o progresso é um só. "Enviar lembrete" avisa cada responsável com passos pendentes.
  O convite para o Spherum continua em Equipe.
- Remover um passo apaga o progresso dele.

## API

- `GET /api/academy?agency_id=` (CAN_READ): `{ items }` (trilhas com `mine` e `who`; onboarding com `done`).
- `POST /api/academy` (CAN_USE), com `{ agency_id, kind, name, description?, steps?, hire_name?, hire_role?, start_date? }`.
- `PATCH /api/academy/:id` (CAN_USE), com `{ acao }`: `editar { item }`, `passo { step_id, done }`,
  `atribuir { user_id, due_date? }`, `desatribuir { user_id }`, `checklist { client_id?, due_date, owner_user? }`, `lembrete`.
- `DELETE /api/academy/:id` (CAN_USE).
