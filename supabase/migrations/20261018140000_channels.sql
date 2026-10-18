-- Canais (Slack, WhatsApp, Telegram) e gatilhos por evento dos Xodós.
--
-- Depende das migrações dos Xodós e das integrações. As conexões dos canais ficam em
-- integration_connections (provider slack, whatsapp_cloud, whatsapp_qr ou telegram).

-- ---------------------------------------------------------------------------
-- Conversas fora do app
-- ---------------------------------------------------------------------------

-- Uma conversa por thread do Slack, número de WhatsApp ou chat do Telegram. A conversa do
-- app continua sendo a das mensagens sem conversation_id (uma por xodó, como no design).
create table public.xodo_conversations (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  channel text not null check (channel in ('slack', 'whatsapp', 'telegram')),
  connection_id uuid references public.integration_connections(id) on delete set null,
  -- Slack: canal:thread; WhatsApp: número; Telegram: id do chat.
  external_key text not null check (char_length(external_key) between 1 and 200),
  title text,
  -- Para onde responder (canal e thread do Slack, número, id do chat).
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  -- Por conexão: o mesmo número no WhatsApp oficial e no QR são conversas diferentes.
  unique (xodo_id, connection_id, external_key)
);
create index xodo_conversations_agency on public.xodo_conversations (agency_id, last_message_at desc);

alter table public.xodo_runs drop constraint if exists xodo_runs_trigger_check;
alter table public.xodo_runs add constraint xodo_runs_trigger_check
  check (trigger in ('user', 'routine', 'channel', 'event'));
alter table public.xodo_runs add column conversation_id uuid references public.xodo_conversations(id) on delete set null;
alter table public.xodo_runs add column event_trigger_id uuid;
create index xodo_runs_event_trigger on public.xodo_runs (event_trigger_id, started_at desc) where event_trigger_id is not null;

alter table public.xodo_messages add column conversation_id uuid references public.xodo_conversations(id) on delete cascade;
-- Quem falou pelo canal, para mostrar no app ("Ana pelo Slack").
alter table public.xodo_messages add column author_label text;
create index xodo_messages_conversation on public.xodo_messages (conversation_id, id) where conversation_id is not null;

-- De onde veio a decisão de um pedido (app, slack, whatsapp, telegram).
alter table public.xodo_actions add column decided_via text;

-- ---------------------------------------------------------------------------
-- Quem fala com os xodós pelos canais
-- ---------------------------------------------------------------------------

-- Pessoa da equipe vinculada a uma conta do canal pelo código de pareamento. Só quem está
-- vinculado (e continua na agência com papel owner, admin ou member) é atendido.
create table public.channel_identities (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  provider text not null check (provider in ('slack', 'whatsapp', 'telegram')),
  -- Slack: time:usuário; WhatsApp: número; Telegram: id do usuário.
  external_user text not null check (char_length(external_user) between 1 and 200),
  user_id uuid not null,
  display_name text,
  created_at timestamptz not null default now(),
  unique (agency_id, provider, external_user)
);

-- Códigos de pareamento: 8 caracteres, uso único, 10 minutos. Guardamos só o hash.
create table public.channel_pairing_codes (
  code_hash text primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index channel_pairing_codes_user on public.channel_pairing_codes (agency_id, user_id);

-- Qual xodó atende em cada canal conectado. No Slack, scope é o id de um canal ou '*' (o
-- workspace todo: menções e mensagens diretas); nos outros, sempre '*'.
create table public.xodo_channels (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  scope text not null default '*' check (char_length(scope) between 1 and 100),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (connection_id, scope, xodo_id)
);

-- ---------------------------------------------------------------------------
-- Entrega e repetições
-- ---------------------------------------------------------------------------

-- O que o xodó escreve numa conversa de canal entra aqui e é entregue em seguida (com novas
-- tentativas pelo cron). approvals leva os pedidos de aprovação ([{action_id, summary}]) para
-- virar botões.
create table public.channel_outbox (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  conversation_id uuid not null references public.xodo_conversations(id) on delete cascade,
  message_id bigint references public.xodo_messages(id) on delete cascade,
  text text not null,
  approvals jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index channel_outbox_pending on public.channel_outbox (next_attempt_at) where status = 'pending';

-- Eventos já recebidos: as plataformas reenviam, e cada evento só pode valer uma vez.
create table public.channel_events (
  source text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (source, event_id)
);
create index channel_events_received on public.channel_events (received_at);

-- ---------------------------------------------------------------------------
-- Gatilhos por evento
-- ---------------------------------------------------------------------------

-- webhook: qualquer sistema chama a URL do gatilho com o segredo.
-- github: webhook do GitHub assinado (X-Hub-Signature-256).
-- email: e-mail novo no Gmail conectado (verificado pelo cron).
-- slack: mensagem num canal do Slack da agência.
create table public.event_triggers (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  kind text not null check (kind in ('webhook', 'github', 'email', 'slack')),
  name text not null check (char_length(name) between 1 and 120),
  -- O que o xodó deve fazer quando o evento chegar (escrito pela equipe).
  instructions text not null default '' check (char_length(instructions) <= 4000),
  connection_id uuid references public.integration_connections(id) on delete cascade,
  -- webhook: event_types; github: events; email: query (busca do Gmail); slack: channel, contains.
  filters jsonb not null default '{}'::jsonb,
  -- webhook: só o hash do segredo. github: o segredo cifrado (a assinatura HMAC precisa dele).
  secret_hash text,
  secret_ciphertext text,
  -- Execuções disparadas por evento seguem no máximo esta autonomia (o conteúdo vem de fora).
  autonomy_cap text not null default 'pergunta_no_que_importa'
    check (autonomy_cap in ('sempre_pergunta', 'pergunta_no_que_importa', 'age_sozinho')),
  max_per_hour integer not null default 20 check (max_per_hour between 1 and 500),
  -- Estado interno (ex.: até quando o Gmail já foi olhado).
  state jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_fired_at timestamptz,
  fire_count integer not null default 0,
  last_error text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index event_triggers_xodo on public.event_triggers (xodo_id);
create index event_triggers_kind on public.event_triggers (kind) where enabled;

-- Registro do que chegou em cada gatilho (aceito, repetido, ignorado, recusado, limitado).
create table public.event_deliveries (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  trigger_id uuid not null references public.event_triggers(id) on delete cascade,
  outcome text not null check (outcome in ('accepted', 'duplicate', 'ignored', 'rejected', 'rate_limited', 'failed')),
  event_type text,
  delivery_id text,
  run_id uuid,
  detail text,
  received_at timestamptz not null default now()
);
create index event_deliveries_trigger on public.event_deliveries (trigger_id, received_at desc);

-- ---------------------------------------------------------------------------
-- Acesso
-- ---------------------------------------------------------------------------

-- Leitura para quem é da agência; toda escrita passa pelo servidor. Códigos de pareamento,
-- fila de entrega e eventos recebidos não são lidos pelo navegador.
do $$
declare t text;
begin
  foreach t in array array['xodo_conversations', 'channel_identities', 'xodo_channels', 'event_triggers', 'event_deliveries',
                           'channel_pairing_codes', 'channel_outbox', 'channel_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  foreach t in array array['xodo_conversations', 'channel_identities', 'xodo_channels', 'event_triggers', 'event_deliveries'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.app_is_agency_member(agency_id))',
      t || '_member_read', t);
  end loop;
end $$;

grant select on public.xodo_conversations, public.channel_identities, public.xodo_channels, public.event_deliveries to authenticated;
-- Os segredos dos gatilhos nunca saem do servidor.
grant select (id, agency_id, xodo_id, kind, name, instructions, connection_id, filters, autonomy_cap, max_per_hour,
              enabled, last_fired_at, fire_count, last_error, created_by, created_at)
  on public.event_triggers to authenticated;
