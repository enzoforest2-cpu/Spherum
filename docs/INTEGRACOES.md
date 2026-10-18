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

**Categoria pelo destino.** Algumas ferramentas olham para quem vai receber antes de decidir a categoria. Isso evita pedir aprovação para falar com o próprio time:
- **E-mail:** para colegas do mesmo domínio da conta conectada é `equipe`; se houver alguém de fora, é `envio`. Domínios de provedores abertos (gmail.com, outlook.com, uol.com.br…) nunca contam como "mesma empresa".
- **Slack:** canal interno é `equipe`; canal compartilhado com outra empresa (Slack Connect) ou mensagem direta para alguém de outro workspace é `envio`.
- **Agenda:** convite que chega a alguém de fora é `envio`; sem convidados de fora, é `alteracao`.
- **GitHub:** issue ou comentário em repositório público é `envio` (fica visível para todos); em privado, é `alteracao`.

Se não der para ver o destino (canal sumiu, API fora do ar), vale a categoria declarada da ferramenta, que é sempre a mais cautelosa.

## Ferramentas dos apps

| App | Ferramenta | Categoria |
|---|---|---|
| Gmail | `buscar_emails`, `ler_email` | leitura |
| | `rascunho_de_email` | rascunho |
| | `enviar_email` (novo, resposta ou rascunho pronto) | envio ou equipe |
| | `organizar_emails` (lido, arquivar, marcadores) | alteracao |
| | `apagar_emails` (lixeira, recuperável por 30 dias) | exclusao |
| Agenda | `ver_agenda` | leitura |
| | `criar_evento` (com Meet se quiser), `alterar_evento` | alteracao ou envio |
| | `responder_convite` | envio ou alteracao |
| | `cancelar_evento` | exclusao |
| Drive | `buscar_no_drive`, `ler_arquivo_do_drive` (Documentos, Planilhas em CSV, Apresentações, texto) | leitura |
| | `criar_documento_no_drive` | alteracao |
| Slack | `listar_canais_do_slack`, `ler_canal_do_slack` | leitura |
| | `enviar_mensagem_no_slack` (canal, thread ou mensagem direta) | equipe ou envio |
| | `reagir_no_slack` | equipe |
| Notion | `buscar_no_notion`, `ler_pagina_do_notion`, `consultar_base_do_notion` | leitura |
| | `criar_pagina_no_notion` (página ou linha de base, com propriedades), `adicionar_na_pagina_do_notion`, `atualizar_pagina_do_notion` | alteracao |
| | `arquivar_pagina_do_notion` | exclusao |
| GitHub | `listar_repositorios_do_github`, `buscar_no_github`, `ler_issue_do_github`, `ler_arquivo_do_github` | leitura |
| | `criar_issue_no_github`, `comentar_no_github` | envio ou alteracao |
| | `mudar_estado_da_issue` | alteracao |

Notas:
- **Drive:** com `drive.readonly` + `drive.file`, o xodó lê qualquer arquivo e só altera o que ele mesmo criou. PDFs e imagens ainda não são lidos (o xodó devolve o link).
- **Slack:** o mesmo app serve as ferramentas e o canal de conversa com os xodós (veja [`CANAIS.md`](CANAIS.md) para Event Subscriptions e Interactivity). O app precisa estar no canal para ler. Para mandar mensagem em canal público, ele entra sozinho (`channels:join`); em canal privado, alguém precisa convidá-lo. Conexões feitas antes dessa permissão precisam reconectar para ganhar o `channels:join`.
- **Notion:** o xodó só enxerga as páginas que a agência compartilhou com a integração no login. A API usada é a versão `2022-06-28`; bases com várias fontes de dados (recurso novo do Notion) pedem a versão `2025-09-03`, que fica para quando aparecer o caso.
- O conteúdo que volta das ferramentas (e-mails, mensagens, documentos) entra no contexto do modelo como informação, nunca como instrução. As instruções do xodó dizem isso explicitamente, e as ações sensíveis continuam passando pela aprovação.

## Anúncios e GA4

Os xodós leem e mexem em Meta Ads, Google Ads e TikTok Ads, e leem o GA4. Tudo passa pela ligação **conta ↔ cliente** (`client_ad_accounts`): o xodó só enxerga contas dos clientes ligados, e só se o app estiver em "Pode mexer em".

**Ligar as contas.** Depois de conectar a plataforma, a agência abre `GET /api/integrations/ad-accounts?agency_id=…&platform=meta|google|tiktok|ga4`, que lista as contas que a conexão enxerga (e a qual cliente cada uma já está ligada), e escolhe em `POST /api/integrations/ad-accounts`. No Google Ads, contas de baixo de uma conta de administrador (MCC) vêm com o `login_customer_id` dela, que o Spherum manda em todas as chamadas. No TikTok, as contas vêm do próprio login.

**Métricas.** O cron sincroniza cada conta a cada 6 horas: 30 dias na primeira vez e, depois, os últimos 3 dias (as plataformas corrigem números recentes). Mídia vai para `metrics_daily` e o GA4 para `analytics_daily` (sessões, usuários, eventos-chave e receita por canal). Contas em dólar são convertidas para reais pela cotação PTAX do dia; outras moedas ficam como estão, com um aviso na conta. Para forçar agora: `POST /api/integrations/ad-accounts/sync` ou a ferramenta `atualizar_metricas`.

**Ferramentas dos xodós.**

| Ferramenta | Categoria | O que faz |
|---|---|---|
| `listar_contas_de_anuncio` | leitura | Contas e propriedades ligadas ao cliente, com a última sincronização |
| `listar_campanhas` | leitura | Campanhas ao vivo, com situação e verba diária em reais |
| `consultar_metricas` / `consultar_analytics` | leitura | Números já sincronizados (mídia e GA4) |
| `atualizar_metricas` | leitura | Sincroniza agora |
| `pausar_campanha` / `ativar_campanha` | campanha | Muda a situação da campanha |
| `ajustar_verba_diaria` | campanha | Muda a verba diária (valor em reais) |

**Limites de campanha por xodó.** Além da autonomia (no nível do meio, toda ação de campanha pede aprovação), cada xodó tem dois limites que **sempre** pedem aprovação, mesmo no "age sozinho":
- `campaign_max_change_pct` (padrão 20): mudança de verba maior que esse percentual;
- `campaign_max_daily_brl` (opcional): verba diária acima desse valor.

O motivo aparece no pedido de aprovação (por exemplo, "limite: mudança de 50%, acima do limite de 20%").

**Versões das APIs:** Meta Graph `v23.0` (`META_GRAPH_VERSION`), Google Ads REST `v23` (`GOOGLE_ADS_API_VERSION`), TikTok Business API v1.3, GA4 Admin e Data `v1beta`. O Google aposenta versões do Ads cerca de um ano depois do lançamento; quando isso acontecer, basta trocar a variável e conferir as notas da versão.

## Servidores MCP

A agência cadastra a URL e o token de qualquer servidor MCP (Streamable HTTP) em `POST /api/integrations` com `provider: "mcp"`. O Spherum confere na hora que o servidor responde e lista as ferramentas. Com o app "Servidor MCP" liberado no xodó, as ferramentas aparecem para ele com o nome `mcp_<servidor>_<ferramenta>`, e a aprovação segue o classificador. Endereços de rede interna são recusados (proteção contra SSRF).

## O que configurar em cada plataforma

Em todas, o endereço de retorno é `https://spherum.com.br/api/integrations/<provedor>/callback`.

| Plataforma | Onde criar | Variáveis | O que a plataforma exige antes de abrir para todos |
|---|---|---|---|
| **Google** (Gmail, Agenda, Drive, Ads, GA4) | Google Cloud Console → APIs e serviços → Credenciais (OAuth, tipo "Aplicativo da Web"). Ative Gmail API, Calendar API, Drive API, Google Ads API e Analytics Data API | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_API_VERSION` (opcional, padrão `v23`) | **Verificação do app pelo Google.** Gmail (`gmail.modify`) e Drive (`drive.readonly`) são permissões restritas: exigem uma **avaliação de segurança anual feita por empresa credenciada (CASA)**, que é paga e leva semanas. A Agenda é sensível (só verificação). O Google Ads exige um developer token aprovado no Centro de API da conta de administrador |
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
| `GET /api/integrations/ad-accounts?agency_id=&platform=` | owner, admin | Contas de anúncio/propriedades do GA4 que a conexão enxerga |
| `POST /api/integrations/ad-accounts` | owner, admin | Liga uma conta a um cliente (`{ agency_id, client_id, platform, external_id, connection_id, name?, currency?, metadata? }`) |
| `DELETE /api/integrations/ad-accounts?agency_id=&id=` | owner, admin | Desliga a conta (as métricas já sincronizadas ficam) |
| `POST /api/integrations/ad-accounts/sync` | owner, admin, member | Sincroniza uma conta agora (`{ agency_id, account_id }`) |

Para escolher os apps de um xodó, use `apps` em `POST /api/xodos` ou `PATCH /api/xodos/:id`, por exemplo `[{ "app": "gmail" }, { "app": "calendar", "connection_id": "…" }]`.

## Banco

- `integration_connections`: uma linha por conta conectada. Os tokens ficam em `ciphertext`, que nem quem está logado consegue ler.
- `oauth_states`: logins em andamento (uso único, 10 minutos), inacessíveis ao navegador.
- `xodo_apps`: apps liberados para cada xodó.
- `client_ad_accounts`: contas de anúncio e propriedades do GA4 de cada cliente, com a conexão usada, a última sincronização e o último aviso.
- `analytics_daily`: números diários do GA4 por cliente, propriedade e canal.
- Em `xodos`: `campaign_max_change_pct` e `campaign_max_daily_brl` (limites de campanha).
