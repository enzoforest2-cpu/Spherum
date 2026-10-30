# Admin do Spherum

Código em `src/lib/core/admin.ts`, `src/lib/core/platform.ts` e `src/lib/core/support.ts`. Tabelas em
`supabase/migrations/20261027100000_admin.sql`. A tela é `design/project/spherum/admin_tpl.html`,
aberta em `/admin`. Só entra quem está em `spherum_staff`, com verificação em duas etapas; o login
do site leva a equipe direto para lá.

- **Primeiro acesso**: a pessoa cria a conta pelo site e alguém com acesso ao banco a coloca como
  dona: `insert into spherum_staff (user_id, role) select id, 'dono' from auth.users where email = '...';`.
  Depois disso, o resto da equipe entra pela tela Equipe Spherum.
- **Funções**:

  | Função | O que pode fazer |
  |---|---|
  | dono | tudo, inclusive equipe, chaves da plataforma, preços e faturas |
  | operacao | plano, suspensão, mensagens, cupons, comunicados, status, suporte, leads e ver a conta da agência |
  | suporte | mensagens, suporte, leads e ver a conta da agência |
  | financeiro | plano, cupons, estorno e cancelamento de faturas |
  | leitura | só vê |

  A equipe nunca fica sem dono: rebaixar ou remover o último é recusado. A conta é feita com trava,
  então dois donos rebaixando um ao outro ao mesmo tempo não zeram a equipe. Para entrar na equipe,
  a pessoa já precisa ter conta.

## Verificação em duas etapas

Obrigatória para toda a equipe do Spherum. Usa o MFA por app autenticador (TOTP) do Supabase Auth,
que precisa estar ligado no projeto (Authentication → Multi-Factor, "TOTP", vem ligado por padrão).

- **No servidor**: todas as rotas da equipe (`/api/admin/**`, `GET /api/leads`, `PATCH /api/leads/:id`
  e `PUT /api/site/demo`) passam por `requireAdmin` em `src/lib/core/http.ts`. Ele confere o token no
  Supabase, a pessoa em `spherum_staff` e o claim `aal` do token. Sem `aal2`, responde 403 com
  `{ error, code: "mfa_required" }`. Quem não é da equipe continua recebendo 404, sem saber da rota.
- **Na tela**: ao receber `mfa_required`, o admin abre o passo da verificação.
  - Primeira vez: cadastra o app (QR code e chave para digitar) e pede o código de 6 dígitos.
  - Depois: a cada login pede o código. O token novo (`aal2`) fica na sessão; renovar a sessão
    mantém o nível.
  - Chamadas direto ao Supabase Auth: `POST /auth/v1/factors`, `/factors/:id/challenge` e
    `/factors/:id/verify`, as mesmas de `supabase.auth.mfa.enroll/challenge/verify`.
- **Equipe Spherum** mostra quem já ativou ("Duas etapas ativas", lido de `auth.mfa_factors`).
- **Perdeu o celular**: alguém com acesso ao banco apaga o fator e a pessoa cadastra de novo no
  próximo login: `delete from auth.mfa_factors where user_id = (select id from auth.users where email = '...');`.

## Página pública de status

`/status` (sem login), com os mesmos dados em `GET /api/public/status`. Código em
`src/lib/core/status.ts` e `src/app/status/page.tsx`. O admin tem o link no rodapé do menu e na tela
Status.

- **Serviços**: situação agora (o incidente aberto mais grave) e 30 dias em barras. Um dia fica
  amarelo quando mais de 10% das execuções do agendador falharam nas etapas do serviço, e da cor do
  incidente quando houve um. Sem execução no dia, fica cinza ("sem dados"). O "% no ar" é a parte
  das execuções sem falha nos 30 dias.
- **Incidentes abertos** e **histórico dos últimos 30 dias**, com as atualizações.
- Não mostra agência, pessoa nem quem escreveu. O texto dos incidentes é público: escreva para a
  agência.
- A página é refeita a cada 60 s.

## O que cada tela faz

- **Visão geral e Métricas**: receita mensal estimada (agências com situação `active` × preço de
  tabela, sem as suspensas), cadastros por mês, conversão do teste, cancelamentos e funil dos
  formulários do site. "Precisa de atenção" junta chamados urgentes, testes acabando em 3 dias,
  saúde baixa e falhas do agendador.
- **Agências**: lista com plano, receita, clientes, saúde e último acesso. No painel da agência
  ficam mudar plano, situação e teste (estender em 7, 14 ou 30 dias), enviar mensagem (aviso no app
  e e-mail para donos e administradores), suspender e reativar.
  - **Saúde**: começa em 100. Tira 40 se o último acesso tem mais de 21 dias, 20 se tem mais de 7 e 8
    se tem mais de 3. Tira 20 sem clientes, 15 sem conexões e 5 sem xodós.
  - **Suspensa**: a equipe e os clientes da agência perdem o acesso, nas rotas do servidor e nas
    regras de acesso do banco. Os links de documentos deixam de abrir. Os dados ficam. Também param:
    - xodós, inclusive retomadas, rotinas, gatilhos de e-mail e aprovações pelos canais;
    - prospecção, posts agendados, automações e busca por IA. Os eventos de automação do período
      não disparam depois da reativação.

    A cobrança e as notas dos clientes da agência continuam, porque são dinheiro e obrigação fiscal
    entre a agência e os clientes dela.
  - **Estender o teste**: move a data do fim do teste. Só volta a situação para "em teste" se a
    agência estava em teste ou com pagamento pendente. Quem paga ou cancelou continua como está.
  - Todas as mudanças de um pedido entram juntas ou nenhuma entra.
  - **Ver como a agência** (suporte, operação e dono): mostra a conta como o dono da agência vê,
    só para ler, sem abrir o app da agência. Mostra:
    - clientes, equipe, integrações e erros de sincronização;
    - assinatura e últimas faturas;
    - últimos chamados com o Spherum e o que pede atenção.

    Não mostra o chat interno da equipe da agência. Cada abertura entra na auditoria. A agência
    recebe um aviso no app ("A equipe do Spherum abriu sua conta para atender o chamado…, só para
    ver, sem alterar nada"), no máximo um por hora. Se a agência tem chamado aberto, o aviso cita o
    mais recente.
- **Leads e demos**: os formulários do site viram um funil (novo, em contato, demo marcada, em
  teste, ganho, perdido), com responsável e anotação. Dá para cadastrar um lead à mão.
- **Receita**: receita mensal pelas faturas pagas da assinatura (veja `docs/ASSINATURA.md`). O anual
  conta dividido por 12. Agência marcada como pagante à mão, para pagamento por fora, entra pelo preço
  de tabela ou pelo preço combinado. As faturas recentes podem ser estornadas pelo Asaas, se pagas,
  ou canceladas, se em aberto.
- **Preço combinado**: no painel da agência. Substitui o preço de tabela a partir da próxima fatura e
  é obrigatório para o plano Empresarial.
- **Cupons**: criar, pausar e encerrar. Cupom já usado é pausado em vez de apagado. A agência aplica
  o cupom ao assinar; ele vale nos meses definidos.
- **Xodó e IA**: chamadas e gasto das chaves das agências nos últimos 30 dias, por provedor e por
  agência.
- **Comunicados**: aviso no app, e-mail ou os dois, para todas, pagantes, em teste, com xodó ou um
  plano. Sai na hora, fica como rascunho ou é agendado; o agendado sai uma vez só, pelo cron.
  - **Envio**: os avisos no app entram de uma vez. Os e-mails saem um por agência, registrados em
    `announcement_deliveries`.
  - **Envio cortado no meio**: se o prazo acabar, o comunicado fica "enviando" e o cron continua de
    onde parou. Ele só vira "enviado" quando o último e-mail sai.
- **Status**: incidentes por serviço com atualizações. A disponibilidade de cada serviço vem das
  execuções do cron das últimas 24 horas (`cron_runs`). Cada execução guarda as etapas que falharam
  e fica 31 dias, para a página pública mostrar 30.
- **Suporte**: chamados das agências para o Spherum. A resposta vai como aviso e e-mail para quem
  abriu o chamado. Se essa pessoa saiu da agência, vai para os donos e administradores. Uma resposta
  da agência reabre o chamado.
- **Auditoria**: as últimas ações das agências e da equipe do Spherum.
- **Configurações**:
  - Agenda de demonstrações do site (`/api/site/demo`).
  - Chaves da plataforma: `xodo`, `studio`, `prospect`, `signup` e `maint`. Desligar uma chave
    para o recurso na hora, com erro 503 explicando.
  - Preços dos planos: cada plano precisa custar mais que o anterior.

  As chaves e os preços ficam em `site_settings`, com 30 s de cache. Mudar uma chave grava só ela,
  mesclando no banco, para que o cache de outro servidor não desfaça a mudança de outra chave.

## No app da agência

- **Central de ajuda**: lista os chamados da agência com o Spherum ("Aguardando", "Respondido",
  "Resolvido"). Abrir um chamado mostra a conversa e um campo para responder. "Abrir chamado de
  suporte" cria um chamado novo, com assunto, descrição e urgência.
- **Notificações**: a gaveta mostra as notificações da agência inteira e as da pessoa, junto com o
  que pede atenção. Abrir a gaveta marca tudo como lido. As notificações da agência inteira são
  compartilhadas: quando uma pessoa lê, fica lida para todos.
- **Aviso no topo**: mostra um aviso por vez, nesta ordem de prioridade:
  1. a manutenção ligada no admin;
  2. o incidente aberto mais grave;
  3. o último comunicado não lido dos últimos 14 dias.

  O comunicado tem botão, se o admin definiu um, e pode ser fechado; fechar marca como lido.
- **Dados**: vêm em `/api/portal/agencia` nos campos `notifications`, `support` e `notice`.
  - `GET /api/notifications?agency_id=` lista as notificações.
  - `POST /api/notifications` com `{ agency_id, ids? }` marca como lidas. Sem `ids`, marca todas.

## Ainda não existe

Estes botões avisam que ainda não estão disponíveis: conceder créditos, convidar agência pelo
admin, ligar e desligar provedores de IA, encerrar sessões e editar a matriz de permissões. A
matriz de permissões é fixa no código (`CAN` em `admin.ts`).

## API

Todas exigem alguém da equipe do Spherum com verificação em duas etapas (sem ela: 403 com
`code: "mfa_required"`). Cada ação confere a função e entra na auditoria.

- `GET /api/admin` devolve
  `{ me, flags, prices, agencies, mrr, metrics, leads, coupons, comms, incidents, cron, staff, audit, tickets, ai }`.
- `PATCH /api/admin/agencies/:id` muda
  `{ plan?, plan_status?, trial_days?, suspend?: { reason }, reactivate? }`.
- `POST /api/admin/agencies/:id` envia mensagem, com `{ subject, body }`.
- `GET /api/admin/agencies/:id/view?ticket=` devolve `{ read_only, viewed_at, summary, portal }`.
  `portal` é o mesmo de `/api/portal/agencia`, visto pelo dono, sem o chat da equipe. `summary` é o
  resumo da tela. `ticket` (opcional) é o chamado citado no aviso.
- `POST /api/admin/staff` com `{ email, role }`.
- `PATCH /api/admin/staff/:userId` com `{ role }`.
- `DELETE /api/admin/staff/:userId`.
- `PATCH /api/admin/settings` com `{ flags?, prices? }` (só dono).
- Cupons:
  - `POST /api/admin/coupons` com
    `{ code, description, kind: pct | brl, value, months?, plans?, max_uses?, valid_until? }`.
  - `PATCH /api/admin/coupons/:code` com `{ status }`.
  - `DELETE /api/admin/coupons/:code` (só cupom nunca usado).
- Comunicados:
  - `POST /api/admin/comms` com
    `{ title, body, channel?, segment?, cta_label?, cta_url?, send: now | schedule | draft, send_at? }`.
  - `POST /api/admin/comms/:id` envia agora.
  - `DELETE /api/admin/comms/:id`.
- Incidentes:
  - `POST /api/admin/incidents` com `{ service, title, severity?, text }`.
  - `PATCH /api/admin/incidents/:id` com `{ status, text }`.
- Suporte:
  - `POST /api/admin/support/:id` responde, com `{ text }`.
  - `PATCH /api/admin/support/:id` com `{ status: open | done }`.
- Leads:
  - `POST /api/admin/leads` com `{ company, name, email, clients?, plan? }`.
  - `PATCH /api/admin/leads/:id` com `{ stage?, owner_user?, note? }`.
- Lado da agência (CAN_READ para ler, CAN_USE para escrever):
  - `GET /api/support?agency_id=`.
  - `POST /api/support` com `{ agency_id, subject, text, priority? }`.
  - `POST /api/support/:id` responde, com `{ agency_id, text }`.

  Quem recebe o aviso de chamado novo é `SUPPORT_NOTIFY_EMAIL`. Se não estiver definido, vai para
  `LEADS_NOTIFY_EMAIL`.

## Alertas para a equipe

`src/lib/core/alerts.ts`. Vão por e-mail para `ALERT_EMAIL` (ou `SUPPORT_NOTIFY_EMAIL`, ou
`LEADS_NOTIFY_EMAIL`) e ficam na tabela `staff_alerts`. Cada assunto avisa uma vez por janela.

- Etapa do agendador que falha em dois ciclos seguidos (janela de 6 horas).
- Fatura do Spherum paga no Asaas depois de cancelada (vira crédito para devolver ou abater).

Agendador parado: `GET /api/saude` devolve `agendador_minutos` (minutos desde o último ciclo). Um
monitor externo (ex.: UptimeRobot, com alerta por palavra-chave) avisa quando passar de 30.
