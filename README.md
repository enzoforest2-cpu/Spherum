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

Banco: Supabase, projeto **spherum** (`fszbxwlxuncqefcwttru`, região São Paulo), na organização *enzoforest2-3275's projects*.

- URL e publishable key já estão em `src/lib/supabase.ts` como padrão (são públicas). As variáveis de `.env.example` são opcionais e, se definidas, têm prioridade.
- Cliente pronto em `src/lib/supabase.ts`.
- Migrações SQL em `supabase/migrations/`.

O front ainda não usa o banco: tudo roda no navegador, com dados fictícios e `localStorage`. Pontos que vão precisar de backend:

- Autenticação (login, cadastro em 5 passos e os três tipos de acesso: agência, cliente e admin).
- Formulário de contato e agendamento de demonstração (hoje usa uma agenda fictícia de Google Agenda).
- Planos, add-ons e cobrança (Asaas, Stripe, Pagar.me ou Mercado Pago).
- Integrações: Meta Ads, Google Ads, GA4, TikTok, RD Station e WhatsApp.
- Xodós: o motor já existe no backend (veja abaixo). Falta ligar a tela do design a ele.

Rotas de API podem ser criadas em `src/app/api/` sem afetar o front.

### Motor dos Xodós

Execução por API com a chave da própria agência, em qualquer um dos mais de 30 provedores do catálogo, modelo local ou outra API compatível com OpenAI, com modelos reserva: aprovações que a equipe decide, gasto registrado em reais (teto diário opcional), chaves cifradas, memória, rotinas agendadas, ferramentas de métricas e relatórios, apps, canais e um computador na nuvem com navegador, arquivos e terminal. Cada agência cria os seus xodós (forma, cor, nome, jeito, cérebro e autonomia), como no assistente do design. Código em `src/lib/xodos/`, rotas em `src/app/api/xodos/` e `src/app/api/cron/xodos/`.

Guias: [`docs/XODOS.md`](docs/XODOS.md), [`docs/INTEGRACOES.md`](docs/INTEGRACOES.md), [`docs/CANAIS.md`](docs/CANAIS.md), [`docs/COMPUTADOR.md`](docs/COMPUTADOR.md), [`docs/COBRANCA.md`](docs/COBRANCA.md), [`docs/COLABORACAO.md`](docs/COLABORACAO.md), [`docs/PROJETOS.md`](docs/PROJETOS.md), [`docs/CONTRATOS.md`](docs/CONTRATOS.md), [`docs/CRM.md`](docs/CRM.md), [`docs/ATAS.md`](docs/ATAS.md), [`docs/CHAMADOS.md`](docs/CHAMADOS.md), [`docs/PROPOSTAS.md`](docs/PROPOSTAS.md), [`docs/FORMULARIOS.md`](docs/FORMULARIOS.md), [`docs/RISCO.md`](docs/RISCO.md), [`docs/DRE.md`](docs/DRE.md), [`docs/RENTABILIDADE.md`](docs/RENTABILIDADE.md), [`docs/CHAT.md`](docs/CHAT.md), [`docs/PROSPECCAO.md`](docs/PROSPECCAO.md), [`docs/AGENDAMENTOS.md`](docs/AGENDAMENTOS.md), [`docs/CONTEUDO.md`](docs/CONTEUDO.md), [`docs/RETORNO.md`](docs/RETORNO.md), [`docs/ACADEMY.md`](docs/ACADEMY.md), [`docs/CONQUISTAS.md`](docs/CONQUISTAS.md), [`docs/AUTOMACOES.md`](docs/AUTOMACOES.md), [`docs/NOTAS.md`](docs/NOTAS.md), [`docs/BUSCA-IA.md`](docs/BUSCA-IA.md), [`docs/ESTUDIO.md`](docs/ESTUDIO.md), [`docs/APP.md`](docs/APP.md), [`docs/ADMIN.md`](docs/ADMIN.md) e [`docs/ASSINATURA.md`](docs/ASSINATURA.md).

```bash
npm test   # 465 testes com PGlite, sem precisar de banco
```

## Xodós local (app de computador)

O app que roda os xodós no computador da agência fica em [`xodos-local/`](xodos-local/README.md),
neste mesmo repositório (antes era o repositório separado `xodos`). Tem as próprias dependências:
`cd xodos-local && npm install && npm test`.
