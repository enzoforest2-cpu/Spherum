# Computador na nuvem dos Xodós

Cada agência pode ter **uma máquina Linux na nuvem** que os xodós usam como um computador: navegador de verdade, pasta de arquivos e terminal. A equipe assiste à tela ao vivo e pode **assumir o controle** quando o xodó pede (login, captcha, algo que só a pessoa decide).

Código em `src/lib/computer/`, scripts da máquina em `sandbox/`, rotas em `src/app/api/xodos/computer/` e migração em `supabase/migrations/20261018160000_computers.sql`.

## Desenho

- **A máquina só executa.** O motor continua no servidor do Spherum. Nenhum token de integração, chave de modelo ou segredo entra nela.
- **Uma máquina por agência**, criada na primeira vez que alguém precisa e pausada sozinha depois de alguns minutos parada (10 por padrão, mínimo 5). Pausada não custa hora de máquina; no E2B, a memória também fica guardada.
- **Provedores:** E2B (primeira opção) ou Daytona, com a **chave da própria agência** (cadastrada em Cérebros e chaves, no mesmo cofre das chaves de modelo). A chave do Spherum só entra se for configurada (um add-on no futuro).
- **Estado no Postgres**, com troca atômica e fence. A Vercel não guarda nada entre chamadas: duas ferramentas ao mesmo tempo criam uma máquina só, e uma transição que morreu no meio é retomada depois de 2 minutos.
- **Uso medido** em sessões (segundos, custo em dólar e em reais pela mesma PTAX do gasto com IA). O teto de horas por dia é obrigatório (4 h por padrão), e uma sessão de mais de 2 h sem ninguém no controle é pausada.
- **Preparo** (`sandbox/prepare.sh`, idempotente): usuário `xodo` sem sudo, usuário `navegador` com a tela e o Chromium, regras de rede por usuário e uma verificação final que aborta se algo ficar exposto. A versão do preparo é o hash da pasta `sandbox/`: depois de um deploy que muda os scripts, a máquina é preparada de novo na próxima retomada.

## Por xodó

Tudo vem desligado (`computer_mode = 'off'`). Ligue com `computer_mode = 'cloud'` e escolha as partes:

| Parte | Ferramentas |
|---|---|
| Navegador | `navegador_abrir`, `navegador_ler`, `navegador_clicar`, `navegador_preencher`, `navegador_tecla`, `navegador_abas` |
| Arquivos | `arquivos_listar`, `arquivo_ler`, `arquivo_escrever`, `arquivo_apagar` (vai para a lixeira), `arquivo_anexar` |
| Terminal | `terminal` (só para xodós que atendem todos os clientes) |
| Sempre | `pedir_controle` |

Com o computador ligado, uma tarefa pode ter até 40 passos.

## Segurança

**Aprovações.** O caminho é o mesmo das outras ferramentas: piso, "exigir aprovação", teto do gatilho, "sempre permitir" e autonomia. O computador acrescenta quatro regras:
- **Piso próprio:** cliente, pagamento e exclusão sempre perguntam.
- **Categoria pelo site e pelo rótulo guardado.** O clique usa o rótulo da foto da página guardada no servidor, nunca o que o modelo escreveu. A agência pode ajustar a categoria por site em `/api/xodos/computer/sites`.
- **"Aprovar sempre" vale só para aquele site** (ex.: `navegador_clicar@business.facebook.com`).
- **Clique aprovado confere a página antes de rodar.** Se a página mudou depois do pedido, nada roda.

**Contaminação.** Ler uma página marca a execução. Dali em diante, o que rodaria sozinho passa a perguntar, porque o conteúdo de fora pode tentar instruir o xodó.

**Terminal.**
- Cada comando passa pelo classificador portado do OpenMausBot (lexer POSIX), que dá a categoria.
- A **nunca-lista** (apagar o disco, bomba de fork, desligar a rede de segurança…) não roda nem vira pedido.
- O comando roda como `xodo`, com ambiente limpo (`env -i`), sem a tela e com tempo máximo.

**Isolamento dentro da máquina.**
- O `xodo` não tem sudo nem senha, e a senha do root fica travada.
- A **tela, o Chromium, os perfis (cookies e logins de cada cliente) e o arquivo de perfil ativo** são do usuário `navegador`. O terminal do xodó e o da pessoa não alcançam o CDP (bloqueado por iptables para o uid do `xodo`), os cookies nem a tela: o Xvfb exige o cookie do Xauthority, que só o navegador tem.
- Rede dos dois usuários:
  - sem redes privadas, metadata da nuvem ou SMTP;
  - os agentes do provedor ficam fechados no loopback;
  - o modo `restrito` corta toda saída.
- Só a porta 6100 (gateway da tela, com token) escuta fora do loopback.
- Os perfis do navegador são separados por cliente. Um xodó de cliente só abre o perfil dos clientes que atende.

**Pastas.** `agencia/`, `clientes/<id>/`, `xodos/<id>/`, `downloads/` e `.lixeira/`:
- o caminho é conferido antes (nada de `..`, links que saem da pasta ou pasta de outro cliente);
- de novo pelo `realpath`, na máquina.

**Dados sensíveis.** Todo resultado passa pela limpeza de segredos antes de ir ao modelo e ao banco. Campos de senha nunca são lidos nem preenchidos pelo xodó.

## Assumir o controle

1. O xodó chama `pedir_controle` com o motivo. A execução para em `waiting_takeover` e a equipe recebe a nota "Preciso de você no computador: …".
2. Alguém (owner, admin ou member) assume: `POST /api/xodos/computer/control`. O lease dura 15 minutos e é renovado a cada 30 s pelo heartbeat, até 2 horas.
   - Só o hash do token fica no banco; o token chega à máquina em base64.
   - Um admin pode tomar o controle de outra pessoa, que é revogada na hora.
   - Ao assumir, **tudo o que o xodó deixou rodando é derrubado**.
3. Enquanto alguém está no controle, toda ferramenta do computador recusa, para todos os xodós.
4. A pessoa devolve com "terminei" (`done`) ou "não fiz" (`skipped`). Também valem:
   - o link de uso único;
   - **qualquer mensagem dela na conversa** (no app ou no canal), que vai junto para o xodó.

   O xodó continua com uma nota dizendo o que aconteceu.
5. Se o lease vencer, o cron derruba o controle e o xodó segue com "ninguém assumiu a tempo". Se ninguém assumir em 24 h, acontece o mesmo.

Na máquina, cada comando de controle roda com trava e fence (`/run/spherum/control.fence`). Assim, um comando atrasado de um lease antigo nunca sobrescreve o de um lease mais novo.

## Execuções longas

Toda execução roda em **fatias de 2 minutos**: nenhum passo começa depois do prazo, e a função da Vercel corta em 300 s. Quando uma fatia acaba:
- o servidor chama `POST /api/xodos/runs/continue` (com `CRON_SECRET`), que responde na hora e continua numa função nova;
- se essa chamada falhar, o cron continua a fatia depois de 1 minuto.

Uma ação que ficou "executando" por mais de 15 minutos (a função morreu no meio) vira falha, com o aviso de conferir antes de tentar de novo.

## Cron

O `GET /api/cron/xodos` (a cada 15 minutos) cuida do computador antes das retomadas, nesta ordem:
1. Dá como pausadas as máquinas que passaram do prazo, fechando a sessão no prazo e não na hora do cron.
2. Pausa sessões longas e termina pausas e exclusões presas.
3. Vence o controle de quem passou do prazo.
4. Limpa as fotos de página com mais de 1 hora e os eventos com mais de 90 dias.

Retomadas, fatias e rotinas param de começar perto do prazo do cron; o resto fica para o ciclo seguinte.

## API

| Rota | Quem pode | O que faz |
|---|---|---|
| `GET /api/xodos/computer?agency_id=` | todos da agência | Estado do card (sem id no provedor nem hash de token) |
| `PUT /api/xodos/computer` | owner, admin | Provedor, chave, minutos até pausar, teto de horas e modo de rede |
| `DELETE /api/xodos/computer?agency_id=` | owner | Desliga de vez e apaga a máquina |
| `POST /api/xodos/computer/start` · `/stop` | owner, admin, member | Liga ou pausa |
| `GET /api/xodos/computer/screen?agency_id=` | todos da agência | URL da tela ao vivo (token de 15 min; com a máquina pausada, não liga nada) e, para quem está no controle, as URLs de controle e terminal |
| `POST /api/xodos/computer/control` | owner, admin, member | Assume o controle |
| `POST /api/xodos/computer/control/heartbeat` | quem está no controle | Renova o lease |
| `POST /api/xodos/computer/control/release` | quem está no controle, owner, admin | Devolve (`done` ou `skipped`) |
| `POST /api/xodos/computer/release-link` | quem tem o link | Devolve pelo link de uso único |
| `GET /api/xodos/computer/events` | todos da agência | Linha do tempo (sem conteúdo de arquivo nem texto digitado) |
| `GET/PUT /api/xodos/computer/sites` | leitura: todos; troca: owner, admin | Categoria por site |
| `GET/POST /api/xodos/computer/key` | owner, admin | Chaves de máquina (E2B, Daytona) |

## Variáveis de ambiente (só no servidor)

| Variável | Para quê |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Bucket privado `computer-files` (anexos e downloads por URL assinada). Sem ela, os anexos ficam desligados |
| `COMPUTER_FILES_BUCKET` | Opcional: outro nome de bucket |
| `APP_URL` | Endereço do app (ex.: `https://spherum.com.br`): encadeia as fatias e marca o próprio Spherum como site da equipe |
| `CRON_SECRET` | Também protege `/api/xodos/runs/continue` |
| `SPHERUM_E2B_API_KEY`, `SPHERUM_DAYTONA_API_KEY` | Opcionais: chave do Spherum para agências sem chave própria |
| `COMPUTER_USD_PER_HOUR_E2B`, `COMPUTER_USD_PER_HOUR_DAYTONA` | Opcionais: custo por hora para o registro (padrão US$ 0,17, para 2 vCPU e 4 GiB) |
| `DAYTONA_COMPUTER_SNAPSHOT` | Opcional: snapshot do Daytona para as máquinas |

Os scripts de `sandbox/` vão no pacote da função (`outputFileTracingIncludes` no `next.config.ts`). O bucket é criado pela migração.

## O que fica para depois

- **Tela de assistir e assumir no front.** As rotas existem, mas o HTML do design ainda não tem o painel. Sem ele, o heartbeat não roda e todo controle vence em 15 minutos (o xodó segue com "ninguém assumiu a tempo").
- **Modo de rede `restrito` com lista de domínios** (hoje ele corta tudo).
- **Computador local** (`computer_mode = 'local'`, a máquina da própria agência). O campo existe, mas ainda não há um agente para instalar.
- **Mais de um xodó esperando.** Devolver o controle retoma a execução que o pediu; as outras continuam esperando até alguém assumir de novo, mandar mensagem ou passarem as 24 h.
