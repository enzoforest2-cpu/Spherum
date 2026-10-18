# Canais e gatilhos dos Xodós

Como a equipe conversa com os xodós fora do Spherum (Slack, WhatsApp e Telegram) e como eventos de fora disparam trabalho (webhook, GitHub, e-mail novo, mensagem no Slack).

Código em `src/lib/channels/`, rotas em `src/app/api/channels/`, `src/app/api/hooks/` e `src/app/api/xodos/[id]/channels|triggers`, banco em `supabase/migrations/20261018140000_channels.sql`.

## Como funciona uma conversa pelo canal

1. **Entrada.** A plataforma chama a rota do canal. A rota confere a assinatura com o corpo cru, responde em seguida (o Slack exige menos de 3 segundos) e processa em segundo plano.
2. **Repetição.** As plataformas reenviam. Cada evento é gravado em `channel_events` e só vale uma vez.
3. **Quem é.** Só conversa quem é da equipe e se vinculou por código (veja "Pareamento"). O papel na agência continua valendo: owner, admin e member conversam e decidem pedidos; viewer não. Quem não está vinculado recebe, uma vez por dia e só em conversa direta, a explicação de como se vincular. Em canal com várias pessoas, silêncio.
4. **Qual xodó.** Se a mensagem chama um xodó pelo nome ("Faísca, como estão os leads?"), é ele. Senão, o xodó daquele canal do Slack e, por último, o do workspace ou número todo (`xodo_channels`).
5. **Conversa.** Cada thread do Slack, número de WhatsApp ou chat do Telegram é uma conversa separada (`xodo_conversations`), com histórico próprio, sem misturar com a conversa do app. As mensagens aparecem no app com o autor ("Ana pelo Slack").
6. **Resposta.** O que o xodó escreve vai para a fila `channel_outbox` junto com a mensagem e é entregue logo depois. Se falhar, a fila tenta de novo com espera crescente (até 1 minuto) e desiste depois de 5 tentativas. Textos longos são divididos no limite de cada plataforma.

Um pedido por vez em cada conversa: se o xodó ainda está trabalhando naquela thread, ele avisa. Em conversas diferentes (app, outra thread), trabalha ao mesmo tempo.

## Pareamento

Modelo do Rakazo. No Spherum, a pessoa gera um código (`POST /api/channels/pairing`): 8 caracteres de um alfabeto sem letras e números parecidos, válido por 10 minutos e de uso único. Só o hash fica no banco. Ela manda o código para o xodó no canal (no Telegram, `/start CÓDIGO` também vale). O código só vale na agência dona do canal. Daí em diante aquela conta do canal fala como ela.

Mandar um código novo revincula a conta (por exemplo, para outra pessoa da equipe). Os vínculos aparecem em `GET /api/channels/identities` e saem com `DELETE /api/channels/identities/:id`.

## Aprovações no canal

Quando o xodó precisa de aprovação numa conversa de canal, o pedido chega ali mesmo:

| Canal | Como decidir |
|---|---|
| Slack | Botões "Aprovar" e "Negar" (Block Kit). A mensagem é atualizada com quem decidiu |
| Telegram | Botões embaixo da mensagem |
| WhatsApp oficial | Botões de resposta (um pedido por mensagem) |
| WhatsApp por QR | Texto: "aprovar" ou "negar" (o gateway não oficial não garante botões) |

Em todos os canais também vale responder "aprovar", "sim", "negar", "não", ou "aprovar 2" quando houver mais de um pedido aberto. A numeração é a mesma nos botões, no texto e nos comandos: a posição entre todos os pedidos abertos daquela conversa. Pedido decidido no app não é pedido de novo no canal, e a continuação do xodó é entregue no canal depois de uma decisão tomada no app.

Quem decide precisa estar vinculado e ter papel que pode aprovar. A decisão registra quem foi e por onde (`xodo_actions.decided_via`: app, slack, whatsapp ou telegram).

## Slack

Um app do Spherum, instalado pela agência no login de Integrações (o mesmo app serve as ferramentas do Slack e o canal). Configuração do app em api.slack.com:

- **Event Subscriptions:** Request URL `https://spherum.com.br/api/channels/slack/events`; eventos de bot `app_mention`, `message.im`, `message.channels` e `message.groups`.
- **Interactivity:** Request URL `https://spherum.com.br/api/channels/slack/interactions`.
- **App Home:** aba Messages ligada (para mensagens diretas).
- **Permissões:** as de `SLACK_BOT_SCOPES` (inclui `chat:write.customize`, para cada xodó responder com o próprio nome). Workspaces que instalaram antes precisam reinstalar para ganhar essa permissão; até lá, as mensagens saem com o nome do app.
- **Variável:** `SLACK_SIGNING_SECRET`.

O xodó atende menções em canais (responde na thread) e mensagens diretas. Mensagens comuns em canal (sem menção) não viram conversa: só disparam gatilhos do tipo `slack`. Mensagens de bots, do próprio app, editadas ou de outros workspaces (Slack Connect) são ignoradas. Para escolher o xodó de um canal: `POST /api/xodos/:id/channels` com `{ connection_id, scope: "C0123ABCD" }`; com `scope: "*"`, ele atende o workspace todo.

## WhatsApp

Os dois caminhos ficam disponíveis, com os riscos explicados.

### Oficial (WhatsApp Business Cloud API) — recomendado

A agência cria o app e o número na Meta (WhatsApp Business) e cola no Spherum `phone_number_id`, um token permanente de usuário do sistema e o `app_secret` (`POST /api/channels/connections` com `provider: "whatsapp_cloud"`). O Spherum confere o número na Meta e devolve a URL do webhook e o token de verificação, que a agência cola no painel da Meta, assinando o campo `messages`. As chamadas que chegam são verificadas com `X-Hub-Signature-256`.

Regras da Meta que valem aqui:
- **Janela de 24 horas:** o xodó só pode mandar texto livre até 24 horas depois da última mensagem da pessoa. Fora disso a Meta recusa (às vezes avisa só depois, pelo status da mensagem) e a entrega fica registrada como falha.
- Só conversa direta; grupos são ignorados. Por enquanto só texto (o xodó avisa quando recebe áudio ou imagem).

### Por QR Code (gateway não oficial, Evolution API)

A agência hospeda (ou contrata) um gateway Evolution API v2 e informa endereço, chave e nome da instância, aceitando os riscos (`accept_risks: true`). O Spherum cria a instância, aponta o webhook e devolve o QR Code para ler no celular (`GET /api/channels/connections/:id/status` mostra a situação e um QR novo quando precisa). Riscos, que a tela deve mostrar antes de conectar (`GET /api/channels/connections`):

- Não é a API oficial: viola os termos de uso do WhatsApp, e o número pode ser banido a qualquer momento, sem aviso.
- Use um número dedicado ao xodó, nunca o número principal da agência.
- A sessão cai de tempos em tempos e é preciso ler o QR Code de novo.
- O gateway vê todas as mensagens desse número e pode forjar mensagens (até aprovações) em nome da equipe: hospede você mesmo ou contrate um fornecedor de confiança.
- Não use para disparos em massa nem para falar com clientes: é só para a equipe conversar com o xodó.
- Não há garantia de entrega.

O endereço do gateway passa pela guarda contra rede interna. O webhook do gateway leva um token na URL (só o hash fica no banco), porque a Evolution não assina as chamadas. Ao desconectar no Spherum, o webhook é desligado e a sessão é encerrada no gateway.

## Telegram

A agência cria um bot no @BotFather (pode ser um por xodó, com o nome dele) e cola o token (`POST /api/channels/connections` com `provider: "telegram"`). O Spherum confere o bot, registra o webhook com um segredo próprio (cabeçalho `X-Telegram-Bot-Api-Secret-Token`) e desliga o webhook ao desconectar. Só conversas privadas por enquanto; grupos são ignorados.

## Gatilhos

Um gatilho faz o xodó trabalhar quando algo acontece fora do Spherum. A equipe escreve o que ele deve fazer (`instructions`), e o evento chega como dado.

| Tipo | Como chega | Autenticação |
|---|---|---|
| `webhook` | `POST /api/hooks/:id` (ou `/api/hooks/:id/:segredo` para sistemas que não mandam cabeçalho) | Segredo `whsec_…` em `Authorization: Bearer`, `X-Spherum-Secret` ou no caminho. Só o hash fica no banco |
| `github` | Webhook do repositório apontado para `/api/hooks/:id` | `X-Hub-Signature-256` com o segredo do gatilho (cifrado no banco) e `X-GitHub-Delivery` obrigatório |
| `email` | O cron olha o Gmail conectado a cada 15 minutos | Conexão Google da agência com `gmail.modify` |
| `slack` | Mensagem comum num canal do Slack da agência | A assinatura do Slack |

Regras:
- **Mesmo erro** para gatilho inexistente, desligado ou segredo errado (401), para não revelar quais existem.
- **Repetição:** chave de idempotência em `Idempotency-Key`, `X-Idempotency-Key`, `X-Webhook-Id`, `Webhook-Id`, `X-GitHub-Delivery` ou `id`/`event_id` do corpo. A mesma entrega só roda uma vez.
- **Filtros:** `event_types` (webhook, pelo cabeçalho `X-Webhook-Event`, `X-Event-Type`, `CE-Type` ou o campo `type`/`event`), `events` (GitHub, ex.: `issues` ou `pull_request.opened`), `query` (busca do Gmail, ex.: `from:cliente.com.br`), `channel` e `contains` (Slack). Fora do filtro, 202 e nada roda.
- **Limites:** `max_per_hour` execuções por hora (padrão 20) e no máximo 3 abertas ao mesmo tempo por gatilho; acima disso, 429.
- **GitHub só com metadados** (modelo do Rakazo): repositório, evento, ação, número, autor, link, branch, sha e conclusão. Nunca o título, o corpo ou o comentário, que qualquer pessoa pode escrever. Se o xodó precisar do texto, ele lê pela ferramenta do GitHub, cujo resultado já é tratado como dado.
- **Conteúdo de fora cercado:** os dados entram no pedido dentro de `<dados_nao_confiaveis>`, com `<`, `>` e `&` escapados, e o xodó é instruído a tratá-los como informação, nunca como instrução.
- **Autonomia limitada:** a execução de um gatilho segue no máximo o `autonomy_cap` dele (padrão "pergunta no que importa": envio, exclusão, pagamento e campanha sempre perguntam, mesmo que o xodó aja sozinho na conversa). Se o gatilho for apagado no meio, vale a mais cautelosa.
- **E-mail:** na primeira vez só marca o ponto de partida (não dispara para e-mails antigos). Remetente, assunto e trecho entram cercados como dados.
- **Registro:** cada chegada fica em `event_deliveries` (aceita, repetida, ignorada, recusada, limitada ou falha), mostrado em `GET /api/xodos/:id/triggers`.

Rotas: `GET/POST /api/xodos/:id/triggers`, `PATCH/DELETE /api/xodos/triggers/:id`, `POST /api/xodos/triggers/:id/rotate` (novo segredo, mostrado uma vez só).

## Rotas dos canais

| Rota | Quem pode | O que faz |
|---|---|---|
| `POST /api/channels/pairing` | owner, admin, member | Gera o código de pareamento da pessoa |
| `GET /api/channels/identities?agency_id=` | owner, admin, member | Vínculos (os seus; owner e admin veem todos) |
| `DELETE /api/channels/identities/:id?agency_id=` | a própria pessoa, owner, admin | Desfaz um vínculo |
| `GET /api/channels/connections` | todos | Riscos do WhatsApp por QR Code |
| `POST /api/channels/connections` | owner, admin | Conecta Telegram, WhatsApp oficial ou WhatsApp por QR |
| `GET /api/channels/connections/:id/status?agency_id=` | owner, admin | Situação do WhatsApp por QR e QR novo |
| `GET/POST/DELETE /api/xodos/:id/channels` | ler: todos; mudar: owner, admin | Em quais canais o xodó atende e as conversas abertas |
| `POST /api/channels/slack/events`, `/slack/interactions` | o Slack | Entrada do Slack |
| `GET/POST /api/channels/whatsapp/:connectionId` | a Meta | Verificação e entrada do WhatsApp oficial |
| `POST /api/channels/whatsapp-qr/:connectionId/:token` | o gateway | Entrada do WhatsApp por QR |
| `POST /api/channels/telegram/:connectionId` | o Telegram | Entrada do Telegram |

O cron (`/api/cron/xodos`) também confere os gatilhos de e-mail, entrega o que ficou na fila e limpa eventos antigos (7 dias), códigos vencidos e o registro de entregas dos gatilhos (30 dias).

## Limites conhecidos

- Slack Connect: mensagens de pessoas de outros workspaces são ignoradas; instalações org-wide do Enterprise Grid ainda não são suportadas.
- WhatsApp: pessoas que usam nome de usuário sem mostrar o número (recurso novo da Meta) ainda não são atendidas.
- Erros permanentes (bot bloqueado, janela de 24 horas fechada) ainda passam pelas 5 tentativas da fila antes de virar falha.
- Endereços informados pela agência (gateway do WhatsApp, servidores MCP, modelos próprios) são conferidos contra rede interna antes de cada chamada, mas um DNS que muda entre a conferência e a conexão não é bloqueado.
