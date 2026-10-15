# Spherum

Plataforma operacional para gestores de tráfego e agências: CRM, campanhas, relatórios, financeiro, propostas e contratos, portal do cliente e os **Xodós** (agentes de IA conectados por API).

## Estrutura

- `design/` — pacote exportado do Claude Design, a referência visual e funcional do produto.
  - `design/project/Spherum 2.0 - Xodo.html` — protótipo principal (abra no navegador; funciona offline).
  - `design/project/spherum/` — fontes de cada tela: `root_tpl.html` (LP, login, cadastro, contato), `agencia_tpl.html` (portal da agência), `cliente_tpl.html` (portal do cliente), `admin_tpl.html` (portal admin).
  - `design/project/Xodo - Completo.html` — sistema dos Xodós isolado.
  - `design/chats/` — conversa completa com as decisões de produto (planos, add-ons, regras de aprovação dos Xodós, limites de gasto etc.).

## Status

Por enquanto, só frontend com dados fictícios. O backend (autenticação, banco de dados, integrações e APIs de IA para os Xodós) ainda não foi implementado.
