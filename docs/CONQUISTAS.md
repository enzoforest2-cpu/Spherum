# Conquistas

Pontos, emblemas e desafio da equipe, medidos pelo que já acontece no Spherum. Código em
`src/lib/core/badges.ts`; reconhecimentos em `kudos` e a configuração em `agencies.badge_config`
(`supabase/migrations/20261022270000_badges.sql`).

## Pontos (padrão, a direção ajusta de 0 a 100)

| Regra | De onde vem | Pontos |
| --- | --- | --- |
| Tarefa entregue no prazo | tarefa de projeto concluída até o prazo (de quem estava com ela) | 10 |
| Relatório publicado | relatório publicado por quem escreveu | 15 |
| Chamado resolvido no prazo | chamado resolvido antes do prazo (do responsável) | 8 |
| Criativo aprovado de primeira | post do Conteúdo aprovado na versão 1 (de quem criou) | 12 |
| Aula de trilha concluída | aula marcada na Academy | 5 |
| Reconhecimento de um colega | reconhecimento recebido (um por dia para a mesma pessoa) | 20 |

O ranking é da semana (a partir de segunda) ou do mês, no horário de Brasília. Com o ranking
escondido, cada pessoa vê só os próprios pontos; a direção vê todos.

## Emblemas do mês

Prazo de ouro (20 tarefas no prazo), Primeira de primeira (10 criativos de primeira), Resposta rápida
(20 chamados no prazo), Relatório redondo (8 relatórios), Sempre aprendendo (uma trilha inteira),
Querido do time (5 reconhecimentos), Cliente salvo (tratou um cliente em risco no radar) e Um ano de
casa (12 meses na agência).

## Desafio

Um por mês, com título e prêmio. O progresso conta os dias do mês sem chamado fora do prazo.

## API

- `GET /api/badges?agency_id=&period=week|month` (CAN_READ).
- `POST /api/badges` (CAN_USE), com `{ agency_id, to_user, text }`: reconhecimento.
- `PATCH /api/badges` (CAN_MANAGE), com `{ agency_id, points?, show_ranking?, challenge? }`.
