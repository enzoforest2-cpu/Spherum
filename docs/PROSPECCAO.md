# Prospecção

Busca de contatos (Google Maps, CNPJ, Instagram, grupos de WhatsApp e planilha) e cadência de mensagens pelo WhatsApp. Código em
`src/lib/core/prospect.ts`; tabelas em `supabase/migrations/20261022220000_prospect.sql`. O navegador
só lê (RLS); importação, envios e respostas passam pelo servidor.

## Fontes

Código das buscas em `src/lib/core/prospect-sources.ts`, rota `/api/prospect/sources`. A busca só
devolve candidatos; a tela marca e importa pela rota de leads, que confere telefone, repetidos e a
lista de bloqueio. Cada contato guarda a origem (`origin`), obrigatória nas fontes de busca.

- **Google Maps**: Places API (Text Search) com a chave do Google Cloud da agência.
- **Empresas por CNAE**: pesquisa da CNPJá (Receita Federal) com a chave da agência; cidade pelo
  código do IBGE.
- **Instagram**: perfis comerciais pelo @, pela conta da Meta conectada (Business Discovery). A lista
  de seguidores de um perfil não existe em API oficial e ficou de fora.
- **Grupos de WhatsApp**: participantes dos grupos do número ligado por QR Code. Não é a API
  oficial; o número pode ser banido, e a tela avisa.
- **Planilha** (CSV) ou números colados, como antes.

Regras:

- **Cota mensal** de contatos vindos de busca (planilha não conta), como no site: Solo 0, Agência
  500 (também no teste), Escala 3.000, Rede 15.000, Empresarial sem limite, mais 1.000 por pacote
  "+1.000 contatos de prospecção". Mês pelo fuso de Brasília.
- **Buscas pagas** (Maps, CNPJá, Instagram): até 20 por minuto e 300 por dia, por agência e fonte.
- **"Carregar mais"**: o token de página vem assinado com os filtros; mudou o filtro, busca de novo.
- **Chaves** (Google Maps e CNPJá): só quem edita Vendas e Configurações cadastra; a nova substitui
  a anterior.
- **Celular sem o 9** (8 dígitos começando com 6 a 9) ganha o 9, para casar com a lista de bloqueio.

O disparo continua só pela API oficial da Meta, com modelos aprovados; as variações são teste A/B
entre modelos.

## Fluxo

1. **Importar**: telefone brasileiro (com ou sem 55, com ou sem máscara). Inválidos, repetidos
   (na lista ou já na agência) e bloqueados ficam de fora.
2. **Cadência**: até 5 passos. Cada passo tem o dia, o texto (corpo do modelo) e o nome do modelo
   na Meta. As variáveis `{nome}`, `{empresa}`, `{segmento}` e `{cidade}` viram `{{1}}`, `{{2}}`…
   na ordem em que aparecem. `{a|b}` não vale: o texto do modelo é fixo.
3. **Disparar**: os leads entram na fila; o cron (a cada 15 min) envia de segunda a sexta, das 9h às
   18h (Brasília), até o limite do dia (10 a 250). Cada follow-up sai `dia do passo − dia do anterior`
   dias depois, se o lead não respondeu.
4. **Respostas**: chegam pelo webhook do WhatsApp oficial e vão para Conversas (não para o xodó).
   Quem responde sai da cadência. A equipe responde por texto livre até 24 horas depois da última
   mensagem do lead; notas internas sempre.
5. **SAIR / PARAR / STOP / CANCELAR / REMOVER**: bloqueia o número na agência para sempre (nem
   importando de novo). A equipe também pode bloquear.
6. **Funil**: Respondeu → Qualificado → Reunião → CRM. "Mover para o CRM" cria o negócio em
   "Contato realizado", com a conversa nas observações.

Para ligar a cadência: conexão do WhatsApp oficial escolhida, modelo em todos os passos e nas
variações ativas, e a última mensagem oferecendo "responda SAIR".

Erro da Meta no envio marca o lead como "Erro no envio" (pode voltar para a fila); limite da Meta
(429) para a agência naquele ciclo, sem marcar ninguém.

## API

- `GET /api/prospect?agency_id=` (CAN_READ): `{ config, leads, variations, stats }`.
- `PATCH /api/prospect` (CAN_MANAGE), com `{ agency_id, connection_id?, daily_limit?, running?, lang?, steps?, variations? }`.
- `POST /api/prospect/leads` (CAN_USE), com `{ agency_id, list, source?, rows? | text?, consent: true, dry_run? }`;
  devolve `{ added, bad, dup, blocked }`.
- `PATCH /api/prospect/leads` (CAN_USE), com `{ agency_id, ids, acao: "fila" | "excluir" }`.
- `GET /api/prospect/leads/:id` (CAN_READ): conversa; marca como lida.
- `PATCH /api/prospect/leads/:id` (CAN_USE), com `{ acao }`: `etapa { stage }`, `dono { owner_user }`,
  `nota { text }`, `parar`, `responder { text }` ou `crm`.

O portal da agência traz `prospect_unread`.

## Regras que valem sempre

- **Reserva antes do envio:** a varredura reserva o lead por 10 minutos (`next_at`) antes de mandar a mensagem; duas varreduras ao mesmo tempo não repetem o passo. Se o envio falhar por limite, a reserva é desfeita.
- **Limite do Meta:** reconhecido tanto como HTTP 429 quanto como HTTP 400 com os códigos 130429, 131056, 131048 e 80007. A agência para neste ciclo sem marcar o lead como erro.
- **Lead que virou cliente ou foi para o CRM** não é mais tratado pela prospecção: a resposta dele vai para o canal normal (xodó ou conversa).
