# Formulários

Código em `src/lib/core/forms.ts`, tabelas em `supabase/migrations/20261022160000_forms.sql`,
página pública em `src/app/f/[code]`.

## Como funciona

- O formulário tem campos de texto, telefone, e-mail e escolha. Um campo pode ter condição
  ("aparece quando o campo X = valor").
- O link público é `/f/<código>`. Para colocar no site, o código de incorporação é um `iframe`
  desse link.
- **Visitas**: cada visita à página é contada.
- **Resposta**: o servidor confere os campos obrigatórios, o formato de telefone e e-mail e as
  opções de escolha. Campos com condição falsa são ignorados.
- **Limite**: 10 respostas por hora por IP (o IP fica guardado só como hash).
- **No CRM**: cada resposta vira um negócio na etapa escolhida (novo, contato ou diagnóstico), com
  origem "Formulário", próxima ação "Responder o lead" e as respostas nas observações. Empresa,
  contato, e-mail, telefone, segmento e site saem dos campos pelo tipo ou pela pergunta. Com o
  aviso ligado, a equipe recebe uma notificação.
- **Editor**: na tela, o editor salva sozinho. A prévia não envia resposta.

## API

- `GET /api/forms?agency_id=` lista os formulários com as respostas dos últimos 90 dias.
- `POST /api/forms` cria um formulário, com
  `{ agency_id, name, fields?, cta?, thanks?, deal_stage?, owner_user?, notify?, active? }`.
- `PATCH /api/forms/:id` altera. `DELETE /api/forms/:id` apaga.
- Rotas públicas, sem login:
  - `GET /api/public/forms/:code`;
  - `POST /api/public/forms/:code`, com `{ [campo]: valor }`. Erros por campo vêm em `fields`.

## Regras que valem sempre

- Se o dono do formulário saiu da equipe, o negócio nasce com o dono da agência como responsável (o formulário público continua aceitando respostas).
- E-mail é validado como no CRM (sem acento no domínio), com mensagem por campo.
