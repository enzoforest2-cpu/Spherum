# App de celular

O "app" é o próprio Spherum instalado na tela de início (PWA), com notificações Web Push. Código em
`src/lib/core/push.ts` (envio em `push-web.ts`), service worker em `public/sw.js`, manifesto em
`public/manifest.webmanifest`, tabelas em `supabase/migrations/20261022320000_push.sql`.

## Configuração (uma vez)

Gere as chaves VAPID (`npx web-push generate-vapid-keys`) e configure no servidor:
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e, opcional, `VAPID_SUBJECT` (ex.: `mailto:contato@...`).
Sem elas, o cron não envia e "Ativar neste aparelho" avisa que não está configurado.

## Como funciona

- **Ativar neste aparelho**: pede a permissão, registra o service worker e grava a inscrição do
  aparelho. No iPhone (iOS 16.4+), primeiro "Adicionar à Tela de Início" e abrir por lá.
- **Categorias** (cada pessoa liga as suas): aprovações, leads e reuniões, falhas, para você
  (reconhecimentos, trilhas, onboarding) e tudo dos xodós. Padrão: as quatro primeiras.
- **Horário de silêncio** (padrão 22h às 7h, Brasília): nesse horário a pessoa não recebe o push; o
  aviso continua no Spherum.
- O cron entrega os avisos (`notifications`) dos últimos 2 dias: aviso de uma pessoa vai só para
  ela; aviso da agência, para toda a equipe. Cada aviso é processado uma vez. Aparelho que cancelou a
  inscrição (404/410) sai da lista.
- O toque abre a tela certa (Xodós, Notas, Publicar, CRM, Agendamentos, Academy…).

## API

- `GET /api/app?agency_id=`: suas preferências, seus aparelhos, quantos da equipe ativaram e a chave pública.
- `PATCH /api/app`, com `{ agency_id, categories?, quiet_start?, quiet_end? }`.
- `POST /api/app/devices`, com `{ agency_id, endpoint, keys: { p256dh, auth }, label? }`; `DELETE /api/app/devices/:id`.
- `POST /api/app/test`, com `{ agency_id }`: notificação de teste para os seus aparelhos.
