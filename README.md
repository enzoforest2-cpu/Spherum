# Spherum

Plataforma operacional para gestores de tráfego e agências: CRM, campanhas, relatórios, financeiro, propostas e contratos, portal do cliente e os **Xodós** (agentes de IA conectados por API).

## Front

O front é **exatamente o que foi exportado do Claude Design**: os arquivos HTML são servidos sem nenhuma alteração por um projeto Next.js 15, publicado na Vercel.

| Rota | Arquivo | O que é |
| --- | --- | --- |
| `/` | `public/site/index.html` | Spherum 2.0 - Xodo: LP, login, cadastro, contato e os três portais |
| `/agencia` | `public/prototipo/agencia.html` | Portal da agência |
| `/cliente` | `public/prototipo/cliente.html` | Portal do cliente |
| `/admin` | `public/prototipo/admin.html` | Portal admin |
| `/video` | `public/prototipo/video.html` | Vídeo de demonstração da LP |
| `/xodo` | `public/prototipo/xodo.html` | Sistema dos Xodós completo |

As rotas ficam em `next.config.ts`. Acessos de demonstração no login: `agencia@demo.com`, `cliente@demo.com` e `admin@demo.com`, todos com a senha `demo123`.

```bash
npm install
npm run dev   # http://localhost:3000
```

## Fontes do design

- `design/project/` — pacote exportado do Claude Design.
  - `design/project/spherum/` — fonte de cada tela, legível: `root_tpl.html` (LP, login, cadastro, contato), `agencia_tpl.html`, `cliente_tpl.html` e `admin_tpl.html`. Os dados fictícios e as regras de tela (planos, add-ons, quiz, validações) estão no `<script>` de cada template.
- `design/chats/` — a conversa completa com as decisões de produto: planos, add-ons, regras de aprovação dos Xodós, limite de gasto diário etc.

Os arquivos em `public/` são *bundles* (com fontes e scripts embutidos). Para entender ou alterar uma tela, leia o template correspondente em `design/project/spherum/`.

## Backend

Ainda não existe. Hoje tudo roda no navegador, com dados fictícios e `localStorage`. Pontos que vão precisar de backend:

- Autenticação (login, cadastro em 5 passos e os três tipos de acesso: agência, cliente e admin).
- Formulário de contato e agendamento de demonstração (hoje usa uma agenda fictícia de Google Agenda).
- Planos, add-ons e cobrança (Asaas, Stripe, Pagar.me ou Mercado Pago).
- Integrações: Meta Ads, Google Ads, GA4, TikTok, RD Station e WhatsApp.
- Xodós: execução por API usando a chave da própria agência (OpenAI, Anthropic, Google ou xAI), com limite diário de gasto e aprovações.

Rotas de API podem ser criadas em `src/app/api/` sem afetar o front.
