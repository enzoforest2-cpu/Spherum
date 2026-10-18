# Motor dos Xodós

Os xodós são colegas de IA que cada agência cria do seu jeito. Este documento explica o motor que roda por trás deles: o que já existe, como funciona e o que falta.

Faísca, Zuca e Nina, que aparecem no design, são só exemplos. Não existe xodó fixo nem função fixa.

O front continua sendo o HTML do design (`public/`). O motor é só backend: código em `src/lib/xodos/`, rotas em `src/app/api/`, banco em `supabase/migrations/20261018120000_xodos.sql` e testes em `tests/`.

## Criação

O assistente do design (`design/project/Xodo - Criar.dc.html`) tem 5 passos, e o motor guarda o que a pessoa escolhe em cada um:

| Passo | Campo em `xodos` | Opções |
|---|---|---|
| Forma | `species` | `pingo`, `bibo`, `oki` |
| Cor | `color` | O nome da cor escolhida (Pingo: Tomate, Cobalto, Menta, Girassol; Bibo: Menta, Lilás, Manteiga, Pêssego; Oki: Ultramar, Coral, Lima, Noite) |
| Nome e jeito | `name`, `personality` | Nome livre (único na agência); `curioso`, `brincalhao`, `direto`, `zen` |
| Cérebro | `provider`, `model`, `credential_id` | Provedor, modelo e a chave de API da agência |
| Cérebro reserva | `xodo_models` | Até 5 modelos reserva, em ordem, de qualquer provedor (com a chave de cada um) |
| Modelo das rotinas | `routine_provider`, `routine_model`, `routine_credential_id` | Opcional: um modelo mais rápido e barato para as rotinas agendadas ("Roteamento" do painel do design). Se ele falhar, o principal assume |
| Limites | `autonomy`, `daily_budget_brl` | `sempre_pergunta`, `pergunta_no_que_importa` (padrão), `age_sozinho`; teto do dia em reais (opcional) |

Também há campos opcionais:
- `role`: um rótulo livre do que ele faz na equipe (ex.: "Relatórios").
- `instructions`: o detalhe do trabalho, nas palavras da agência.

Tudo isso pode ser trocado depois (`PATCH /api/xodos/:id`), inclusive o cérebro: para trocar de provedor, é preciso informar o modelo e uma chave do novo provedor.

O jeito escolhido define o tom das respostas e a saudação, com os mesmos textos do design. A autonomia define o que ele faz sem perguntar (veja Aprovações).

## De onde vieram as ideias

| Repositório | O que aproveitamos |
|---|---|
| **Rakazo** | A biblioteca de modelos pi-ai (catálogo amplo, conversa que passa de um provedor a outro), a lista de modelos reserva, o motor de regras de aprovação, o livro de gastos por chamada (reserva antes, acerto depois), o cofre AES-256-GCM com sal por registro e AAD, as rotinas com continuidade |
| **OpenMausBot** | Piso de segurança (o que sai para fora sempre pergunta), memória curta carregada em toda conversa, aviso de gasto em 80% |
| **OpenDots** | O servidor executa só o pedido guardado, uma única vez e com prazo; leitura roda sem perguntar; revisar antes de salvar; a guarda contra endereços internos (SSRF) |

Uma mudança em relação ao Rakazo: lá a regra mais específica vence. Aqui **"exigir aprovação" sempre vence "sempre permitir"**, para que uma regra larga da agência nunca seja furada por uma regra estreita de um xodó.

## Como funciona uma conversa

1. A pessoa manda uma mensagem (`POST /api/xodos/:id/messages`). A rota responde `202` com o `run_id`, e o xodó trabalha em segundo plano.
2. O executor (`runner.ts`) monta a persona, a memória, os clientes que o xodó pode atender e as últimas 20 mensagens, e entra no laço de passos (no máximo 12):
   - se houver teto, **reserva** o pior caso da chamada em reais (prompt inteiro sem cache + 8.000 tokens de saída). Se não couber, o xodó para e avisa;
   - **chama o modelo** com a chave da agência. Se o provedor falhar ou o modelo recusar, o próximo modelo reserva assume com a mesma conversa;
   - **registra** o gasto real em `ai_usage` (dólar e reais) e libera a reserva;
   - **trata as ferramentas pedidas**: o que pode rodar, roda; o que precisa de aprovação vira um pedido em `xodo_actions` e a execução para em `waiting_approval`.
3. Alguém da equipe decide (`POST /api/xodos/actions/:id`). Aprovado, o servidor executa **o input guardado** (o corpo da requisição só decide), confere o hash do input e retoma a execução quando todas as ações daquele passo estiverem decididas.
4. A resposta final entra em `xodo_messages`. O navegador lê por `GET /api/xodos/:id/messages` ou direto do Supabase (RLS deixa cada pessoa ler só a própria agência).

## Aprovações

Ordem de decisão (`policy.ts`):

1. **Piso de segurança:** ferramentas da categoria `cliente` (ex.: `publicar_relatorio`) sempre pedem aprovação. "Aprovar sempre" vira aprovação de uma vez só. É o que o design promete: *"Você revisa e aprova antes de qualquer coisa ir para o cliente."*
2. Qualquer regra `require_approval` que case, da agência (`xodo_id` nulo) ou do xodó.
3. Qualquer regra `always_allow` que case.
4. A **autonomia** escolhida na criação:

| Categoria | Sempre pergunta | Pergunta no que importa | Age sozinho |
|---|:-:|:-:|:-:|
| `leitura` (consultar dados) | roda | roda | roda |
| `rascunho`, `memoria`, `equipe` | pergunta | roda | roda |
| `campanha` (mexer em verba) | pergunta | pergunta | roda |
| `cliente` (vai para o cliente) | pergunta | pergunta | pergunta |

Ler dados nunca pede aprovação, porque não muda nada. O que vai para o cliente pergunta mesmo em "Age sozinho": é o piso do item 1.

Cada pedido vale por 24 horas, e só a primeira decisão conta: a troca de `pending` para `approved` ou `denied` é atômica, então cliques simultâneos executam uma vez só. Os pedidos que vencem são retomados pelo cron, e o xodó avisa que nada foi feito.

## Cérebro: provedores e modelos reserva

A camada de modelos usa a biblioteca **pi-ai** (MIT), a mesma do Rakazo (`llm.ts`):
- **Catálogo amplo:** mais de 30 provedores que funcionam com chave de API (Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Groq, OpenRouter, Together, Fireworks, Cerebras, Moonshot, MiniMax, Z.AI, Hugging Face, NVIDIA e outros), com janela de contexto e preço de cada modelo. `GET /api/xodos/catalog` lista tudo para o passo "Cérebro".
- **Servidor próprio:** `local` (Ollama, LM Studio) e `custom` (qualquer API compatível com OpenAI), num endereço informado pela agência. O endereço precisa ser público: o servidor do Spherum não alcança o computador da agência, e endereços de rede interna são recusados (proteção contra SSRF).
- **Ficam de fora** os provedores que pedem credencial de nuvem ou login de assinatura (Bedrock, Azure, Vertex, Cloudflare, Copilot, Codex).

**Modelos reserva (`xodo_models`):** até 5, em ordem, cada um com sua chave. Se o principal falhar (instabilidade, limite de uso, chave recusada) ou recusar o pedido, o próximo assume no meio da tarefa com a mesma conversa; a pi-ai converte o histórico entre provedores. Depois que um reserva assume, ele segue até o fim daquela tarefa. Cada tentativa, inclusive as que falharam, fica em `ai_usage` com o número da tentativa e o erro.

A conversa interna fica em `xodo_runs.transcript`, no formato da pi-ai, e nunca vai para o navegador.

## Gasto em reais e teto opcional

Todo gasto é registrado em `ai_usage` em dólar (preço do catálogo) e em reais, pela cotação PTAX de venda do Banco Central (`fx_rates`). O cron busca a cotação; fins de semana e feriados usam a última conhecida. Modelos de servidor próprio não têm preço: o gasto fica registrado com `cost_source = 'unknown'`.

O gasto do dia por xodó fica somado em `xodo_budget_days`. **Por padrão não há teto: o gasto só é registrado.** Se a agência quiser, pode definir `daily_budget_brl` (o "Orçamento por dia" do design). Aí:

| Momento | O que acontece |
|---|---|
| Passa do percentual de aviso (`warn_at_percent`, padrão 80) | Notificação `budget_warning`, uma vez por dia |
| A próxima chamada não cabe | O xodó para (`paused_budget`), com notificação `budget_capped` uma vez por dia |
| Dia seguinte, ou teto aumentado ou removido | O xodó volta a rodar |

As funções `xodo_budget_reserve` e `xodo_budget_settle` travam a linha do dia, então chamadas em paralelo não estouram o teto.

## Chaves de API

A agência cadastra a própria chave (`POST /api/xodos/credentials` com `provider`, `label`, `api_key` e, para `local` e `custom`, `base_url`; servidor local pode não ter chave). Ela é cifrada com AES-256-GCM (chave derivada de `XODOS_ENCRYPTION_KEY` por scrypt, sal novo a cada gravação e AAD com agência + id) e só é decifrada na hora da chamada. Depois de cadastrada, só os 4 últimos caracteres aparecem. A coluna `ciphertext` não é legível nem por quem está logado (permissão por coluna).

**Não troque `XODOS_ENCRYPTION_KEY` depois de ter chaves cadastradas:** elas deixam de abrir.

## Memória

Cada xodó tem um texto de até 24 mil caracteres que entra em toda conversa. Ele mesmo atualiza pela ferramenta `atualizar_memoria`. Antes de salvar, o motor apaga chaves de API, tokens, CPF, cartões e senhas rotuladas, e toda versão anterior vai para `xodo_memory_revisions` (dá para desfazer com `restoreMemory`).

## Ferramentas

| Ferramenta | Categoria | O que faz |
|---|---|---|
| `listar_clientes` | leitura | Clientes que o xodó pode atender |
| `consultar_metricas` | leitura | Investimento, cliques, leads, CPL, ROAS… por período, dia, campanha ou plataforma |
| `comparar_periodos` | leitura | Variação de cada métrica entre dois períodos |
| `listar_relatorios` | leitura | Relatórios recentes |
| `ler_relatorio` | leitura | Conteúdo de um relatório |
| `criar_rascunho_relatorio` | rascunho | Salva um relatório como rascunho para revisão |
| `publicar_relatorio` | cliente | Publica no portal do cliente (sempre pede aprovação) |
| `avisar_equipe` | equipe | Manda uma notificação para a equipe |
| `atualizar_memoria` | memoria | Reescreve a memória do xodó |

Todo xodó nasce com todas as ferramentas ligadas. Quem decide o que roda sem perguntar é a autonomia. A agência pode desligar uma ferramenta para um xodó com uma linha em `xodo_tools`.

Toda ferramenta valida a entrada com zod e só enxerga a própria agência e os clientes liberados ao xodó (`client_scope` = `all` ou `selected` + `xodo_clients`). Um gatilho no banco impede ligar um cliente de outra agência.

As métricas vêm de `metrics_daily` (uma linha por cliente, plataforma, conta, campanha e dia, com valores em centavos). **Essa tabela ainda precisa ser alimentada pelas integrações** (Meta Ads, Google Ads, GA4…).

## Rotinas

Uma rotina é um pedido agendado em cron de 5 campos, no fuso da agência (ex.: `0 8 * * 1`, toda segunda às 8h). O mínimo é de uma vez por hora. Com `continuity`, o resumo da última execução entra na próxima.

A rota `GET /api/cron/xodos` (com `Authorization: Bearer $CRON_SECRET`) faz três coisas:
- vence os pedidos de aprovação sem resposta;
- encerra execuções travadas;
- roda as rotinas vencidas, travando cada uma por 15 minutos para não haver sobreposição.

Ela deve ser chamada a cada 15 minutos. O Vercel Cron no plano Hobby só roda uma vez por dia (e um agendamento mais frequente quebra o deploy), por isso a sugestão é o `pg_cron` + `pg_net` do próprio Supabase, que funcionam no plano grátis:

```sql
-- No SQL Editor do Supabase, depois de ativar as extensões pg_cron e pg_net
-- e guardar o segredo no Vault com o nome cron_secret:
select cron.schedule('xodos', '*/15 * * * *', $$
  select net.http_get(
    url := 'https://spherum.com.br/api/cron/xodos',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 290000
  );
$$);
```

## API

Toda rota exige o token do Supabase Auth em `Authorization: Bearer <access_token>` e confere o papel da pessoa em `agency_members`.

| Rota | Quem pode | O que faz |
|---|---|---|
| `GET /api/xodos?agency_id=` | todos da agência | Lista os xodós da agência |
| `GET /api/xodos/catalog[?provider=]` | qualquer pessoa logada | Provedores do catálogo e, com `provider`, os modelos com contexto e preço |
| `POST /api/xodos` | owner, admin | Cria um xodó com o que saiu do assistente (`agency_id`, `name`, `species`, `color`, `personality`, `provider`, `model`, `credential_id`, `autonomy`; opcionais: `backup_models`, `daily_budget_brl`, `role`, `instructions`, `client_ids`) |
| `PATCH /api/xodos/:id` | owner, admin | Troca qualquer escolha (nome, forma, cor, jeito, cérebro, reservas, autonomia, teto), pausa ou retoma |
| `GET /api/xodos/:id/messages` | todos da agência | Conversa recente, pedidos pendentes e a última execução |
| `POST /api/xodos/:id/messages` | owner, admin, member | Manda uma mensagem (`{ text }`) e responde `202` |
| `POST /api/xodos/actions/:id` | owner, admin, member | Decide um pedido (`{ approve, scope: "once" \| "always", reason }`) |
| `GET/POST /api/xodos/:id/routines` | leitura: todos; criar: owner, admin | Lista e cria rotinas |
| `GET/POST/DELETE /api/xodos/credentials` | owner, admin | Lista, cadastra e revoga chaves de API |
| `GET /api/cron/xodos` | o agendador, com `CRON_SECRET` | Cotação do dólar, faxina e rotinas |

## Banco

A migração `20261018120000_xodos.sql` cria as tabelas, as funções de teto e de rotinas e as políticas de acesso:
- Quem está logado só **lê**, e só a própria agência.
- Toda escrita passa pelo servidor, que filtra por `agency_id`.
- A chave cifrada e a conversa interna (`transcript`) ficam fora do alcance do navegador.

**Ordem:** essa migração depende das tabelas `agencies`, `agency_members` e `clients` da migração base do backend. Aplique a base primeiro. O arquivo `tests/fixtures/foundation.sql` mostra o mínimo que o motor espera dessas tabelas (`agencies.name`, `agency_members.role` com owner/admin/member/viewer, `clients.agency_id` e `clients.name`).

## Variáveis de ambiente (só no servidor)

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Conexão de serviço do Supabase. Use o pooler em modo transação (porta 6543) |
| `XODOS_ENCRYPTION_KEY` | Chave mestra do cofre, com 32 caracteres ou mais (ex.: `openssl rand -base64 48`) |
| `CRON_SECRET` | Segredo que o agendador manda para `/api/cron/xodos` |

Nenhuma delas vai para o Git nem para o navegador. Configure em Vercel → Settings → Environment Variables.

## Testes

```bash
npm test
```

São 62 testes com `node:test`, PGlite (Postgres em memória, sem precisar de Docker) e o provedor falso da pi-ai. Eles cobrem:
- as regras de aprovação;
- o gasto em reais, a cotação e o teto opcional (inclusive com reservas simultâneas);
- o fluxo completo de aprovação, negação, vencimento e execução única;
- a troca para o modelo reserva no meio da tarefa;
- o isolamento entre agências e a RLS;
- o catálogo de modelos, a guarda contra endereços internos, o cofre, a memória e as rotinas.

## O que falta

- **Integrações de anúncios** para alimentar `metrics_daily` (Meta Ads, Google Ads, GA4, TikTok).
- **Ferramentas de campanha** (pausar, remanejar verba) na categoria `campanha`, com limite por agência.
- **Apps:** o passo "Limites" tem "Pode mexer em" (Gmail, Agenda, Slack, WhatsApp, Notion, GitHub, Drive). Essas integrações ainda não existem.
- **Limites por plano** (Agência: 1 xodó e 5 rotinas; Escala: 3 e 30; Rede: 5 e ilimitadas; Empresarial: 10), quando a cobrança existir.
- **Ligar a tela de Xodós do design a estas rotas.** Hoje o front é o HTML estático do design.
- Atualização em tempo real (Supabase Realtime em `xodo_messages`) no lugar de consultar a rota de tempos em tempos.
