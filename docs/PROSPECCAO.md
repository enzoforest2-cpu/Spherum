# Prospecção

Cadência de mensagens pelo WhatsApp para listas que a agência já tem. Código em
`src/lib/core/prospect.ts`; tabelas em `supabase/migrations/20261022220000_prospect.sql`. O navegador
só lê (RLS); importação, envios e respostas passam pelo servidor.

## O que ficou de fora do design (de propósito)

O design capta telefones de seguidores do Instagram e de participantes de grupos de WhatsApp e
dispara por números "aquecidos" via QR Code, com variações reescritas para escapar do bloqueio. Isso
fere a LGPD (dados pessoais coletados sem base legal) e os termos do WhatsApp, e põe os números da
agência em risco. Por isso a versão real:

- só importa listas da própria agência (planilha CSV ou números colados), com a confirmação de que
  os contatos podem receber mensagem;
- envia só pela API oficial da Meta, com modelos aprovados (a Meta exige modelo para começar
  conversa);
- usa variações como teste A/B entre modelos aprovados, com a taxa de resposta de cada uma.

Google Maps (API Places) e CNPJ (base pública da Receita) podem entrar depois, como fontes de
negócios (não de pessoas).

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
