# Integrações dos Xodós

Como os xodós se conectam a apps e plataformas: Gmail, Agenda, Drive, Google Ads, GA4, Meta Ads, TikTok Ads, Slack, Notion, GitHub, WhatsApp, Telegram e servidores MCP.

Código em `src/lib/integrations/`, rotas em `src/app/api/integrations/`, banco em `supabase/migrations/20261018130000_integrations.sql`.

## Decisão: login próprio do Spherum

Cada plataforma tem **um app do Spherum**, e a agência faz login nele. A tela de permissão mostra "Spherum", os tokens ficam com o Spherum, cifrados, e não há intermediário pago no caminho. Os três repositórios usavam Composio ou Pipedream; escolhemos o login próprio porque é o melhor para o sistema rodando em escala: marca própria, controle das permissões e nenhum terceiro guardando os acessos dos clientes (LGPD).

O preço disso é que **cada plataforma precisa aprovar o app do Spherum** antes de abrir para qualquer agência. Veja a seção "O que configurar em cada plataforma".

## Como funciona

1. **Conectar.** O navegador chama `POST /api/integrations/:provider/start` com os apps desejados (ex.: `["gmail", "calendar"]`) e recebe a URL de login. O servidor guarda um `state` de uso único, que vence em 10 minutos, com PKCE onde a plataforma aceita (Google).
2. **Voltar.** A plataforma devolve a pessoa para `/api/integrations/:provider/callback`. O servidor:
   - consome o `state` numa troca atômica;
   - troca o código pelos tokens e descobre a conta (e-mail do Google, workspace do Slack…);
   - grava tudo cifrado em `integration_connections`.

   Reconectar a mesma conta atualiza os tokens e soma as permissões, sem duplicar a conexão.
3. **Usar.** O xodó só usa um app se ele estiver em "Pode mexer em" (`xodo_apps`). A ferramenta pega a conexão fixada no xodó ou a mais recente da agência que tenha as permissões daquele app. Antes de vencer, o token é renovado com a linha travada no banco, para duas chamadas ao mesmo tempo não renovarem juntas. Se a plataforma recusar a renovação, a conexão vira "vencida" e o xodó avisa para reconectar.
4. **Desconectar.** `DELETE /api/integrations/connections/:id` revoga na plataforma, quando ela permite, e apaga os tokens.

## Aprovação das ações de apps

Cada ferramenta tem uma categoria, e a autonomia escolhida na criação do xodó decide o que roda sem perguntar:

| Categoria | Exemplo | Sempre pergunta | Pergunta no que importa | Age sozinho |
|---|---|:-:|:-:|:-:|
| `leitura` | listar e-mails, ler métricas | roda | roda | roda |
| `alteracao` | criar evento, editar página | pergunta | roda | roda |
| `envio` | mandar e-mail, mensagem, post | pergunta | pergunta | roda |
| `exclusao` | apagar, arquivar | pergunta | pergunta | roda |
| `pagamento` | cobrar, pagar, transferir | pergunta | pergunta | roda |
| `campanha` | pausar anúncio, mudar verba | pergunta | pergunta | roda |
| `cliente` | publicar no portal do cliente | pergunta | pergunta | pergunta |

As ferramentas dos conectores nativos já vêm com a categoria certa. As de servidores MCP passam por um **classificador** (`classify.ts`, adaptado do OpenMausBot e do Rakazo), que lê o verbo do nome:
- `SEND_EMAIL` é envio, mas `GET_POST` é leitura;
- criar uma mensagem conta como envio, mas criar um rascunho não;
- o aviso de "só leitura" do servidor nunca alivia o que o nome diz, e na dúvida a ferramenta não é tratada como leitura.

## Servidores MCP

A agência cadastra a URL e o token de qualquer servidor MCP (Streamable HTTP) em `POST /api/integrations` com `provider: "mcp"`. O Spherum confere na hora que o servidor responde e lista as ferramentas. Com o app "Servidor MCP" liberado no xodó, as ferramentas aparecem para ele com o nome `mcp_<servidor>_<ferramenta>`, e a aprovação segue o classificador. Endereços de rede interna são recusados (proteção contra SSRF).

## O que configurar em cada plataforma

Em todas, o endereço de retorno é `https://spherum.com.br/api/integrations/<provedor>/callback`.

| Plataforma | Onde criar | Variáveis | O que a plataforma exige antes de abrir para todos |
|---|---|---|---|
| **Google** (Gmail, Agenda, Drive, Ads, GA4) | Google Cloud Console → APIs e serviços → Credenciais (OAuth, tipo "Aplicativo da Web"). Ative Gmail API, Calendar API, Drive API, Google Ads API e Analytics Data API | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN` | **Verificação do app pelo Google.** Gmail (`gmail.modify`) e Drive (`drive.readonly`) são permissões restritas: exigem uma **avaliação de segurança anual feita por empresa credenciada (CASA)**, que é paga e leva semanas. A Agenda é sensível (só verificação). O Google Ads exige um developer token aprovado no Centro de API da conta de administrador |
| **Meta** (Meta Ads e WhatsApp oficial) | developers.facebook.com → Criar app (tipo Empresa), produtos "Login do Facebook para Empresas", "API de Marketing" e "WhatsApp" | `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION` (opcional, padrão `v23.0`) | **Verificação da empresa** e **Análise do app** para `ads_management`, `ads_read`, `business_management` e as permissões do WhatsApp. O token da Meta dura cerca de 60 dias e não tem renovação automática: perto de vencer, a agência reconecta |
| **TikTok** | business-api.tiktok.com → My Apps | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | Aprovação do app pelo TikTok, com a permissão de relatórios e de gestão de anúncios |
| **Slack** | api.slack.com/apps → Create New App | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | Ativar a "distribuição pública" do app para outros workspaces instalarem. Para entrar no diretório do Slack, há revisão |
| **Notion** | notion.so/my-integrations → nova integração **pública** | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | Integração pública com site e política de privacidade |
| **GitHub** | github.com/settings/developers → OAuth Apps | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Nada especial |

Enquanto uma plataforma não é configurada, `GET /api/integrations` mostra `configured: false` para ela, e tentar conectar devolve uma mensagem clara. Variável geral: `APP_URL` (padrão `https://spherum.com.br`), usada nos endereços de retorno.

## Rotas

| Rota | Quem pode | O que faz |
|---|---|---|
| `GET /api/integrations?agency_id=` | todos da agência | Conexões e catálogo de apps (com o que já está configurado) |
| `POST /api/integrations/:provider/start` | owner, admin | Começa o login (`{ agency_id, apps, return_to? }`) e devolve `{ url }` |
| `GET /api/integrations/:provider/callback` | a plataforma | Volta do login; redireciona para o Spherum com `integracao=…&status=ok\|erro` |
| `POST /api/integrations` | owner, admin | Conexão por chave: servidor MCP (`{ agency_id, provider: "mcp", label, url, token? }`) |
| `DELETE /api/integrations/connections/:id?agency_id=` | owner, admin | Desconecta |

Para escolher os apps de um xodó, use `apps` em `POST /api/xodos` ou `PATCH /api/xodos/:id`, por exemplo `[{ "app": "gmail" }, { "app": "calendar", "connection_id": "…" }]`.

## Banco

- `integration_connections`: uma linha por conta conectada. Os tokens ficam em `ciphertext`, que nem quem está logado consegue ler.
- `oauth_states`: logins em andamento (uso único, 10 minutos), inacessíveis ao navegador.
- `xodo_apps`: apps liberados para cada xodó.
- `client_ad_accounts`: contas de anúncio e propriedades do GA4 de cada cliente, para a sincronização de métricas.
