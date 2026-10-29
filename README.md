# Xodós

Seus ajudantes de IA rodando no seu computador. Eles conversam com você, pesquisam na internet,
organizam a pasta `Documentos\Xodós`, guardam memória e cuidam de rotinas no horário. Antes de
qualquer coisa importante (apagar, enviar, pagar), pedem a sua aprovação.

O motor é o mesmo dos xodós do Spherum, adaptado para uso pessoal: o banco é um Postgres embutido
(PGlite) e tudo fica no seu computador.

## Usar no Windows

1. Baixe `Xodos-windows.zip`, clique com o botão direito > Propriedades > marque **Desbloquear** > OK.
2. Descompacte numa pasta fixa (ex.: `Documentos\Programas\Xodos`).
3. Dois cliques em **Abrir Xodos.bat**. A tela abre no navegador em http://127.0.0.1:4747.

O `LEIA-ME.txt` dentro do pacote explica o resto (iniciar com o Windows, backup, atualizar).

## Desenvolver

```bash
npm install
npm run dev            # monta a tela e abre o servidor em http://127.0.0.1:4747
npm test               # testes
npm run typecheck
npm run pack:windows   # gera dist/Xodos-windows.zip (com Node portátil)
```

Variáveis úteis: `XODOS_DADOS` (pasta dos dados), `XODOS_PORTA`, `XODOS_NAO_ABRIR=1` (não abre o navegador).

## Organização

- `server/` — servidor local (só 127.0.0.1, com token por abertura), API, agendador.
- `ui-src/` — tela (React), montada em `ui/` por `scripts/build-ui.mjs`.
- `src/xodos/` — motor dos xodós (execução, aprovações, memória, rotinas).
- `src/local/` — ferramentas pessoais: pesquisa na web, leitura de páginas, pasta de arquivos.
- `db/` — esquema do banco (migrações do Spherum + base).

## Integrações

Na tela **Integrações**:

- **Google (Gmail, Agenda, Drive):** cada pessoa cria o próprio "app do Google" (ID do cliente OAuth do
  tipo *App para computador*) e cola na tela; ele fica cifrado em `google-oauth.json` na pasta de dados.
  O login volta para `http://127.0.0.1:<porta>/api/integrations/google/callback`. Depois, em cada xodó →
  Ajustes → **Pode usar**, escolha o que ele mexe. Variáveis `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
  têm prioridade, como no Spherum.
- **Telegram:** token de um bot do @BotFather. O app escuta por long polling (não precisa de endereço
  público) e só atende quem mandar o código de vínculo. Pedidos de aprovação viram botões.
- **WhatsApp (API oficial da Meta):** ID do número + token + o seu número. O envio funciona direto;
  para receber, a Meta chama `/webhook/whatsapp` (precisa de endereço público, ex.: túnel), assinado
  com a chave secreta do app da Meta.

Nos dois canais, os avisos do sino também são repassados (dá para desligar por canal). O código fica em
`server/integrations.ts` e `server/channels.ts`; o motor (`src/`) é o mesmo do Spherum.
