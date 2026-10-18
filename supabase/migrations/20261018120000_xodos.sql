-- Motor dos Xodós: colegas de IA de cada agência.
--
-- Depende da migração base (agencies, agency_members, clients) e de auth.uid() do Supabase.
-- Escritas acontecem só pelo servidor (conexão de serviço), que filtra tudo por agency_id;
-- pessoas logadas apenas leem, sob RLS. Nenhuma chave de API sai do servidor.

-- ---------------------------------------------------------------------------
-- Funções de apoio
-- ---------------------------------------------------------------------------

create or replace function public.app_is_agency_member(p_agency uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.agency_members m
    where m.agency_id = p_agency and m.user_id = auth.uid()
  );
$$;

-- Garante que o cliente referenciado pertence à mesma agência da linha.
create or replace function public.app_check_client_agency()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_id is not null and not exists (
    select 1 from public.clients c where c.id = new.client_id and c.agency_id = new.agency_id
  ) then
    raise exception 'cliente % não pertence à agência %', new.client_id, new.agency_id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dados que o Faísca lê e escreve
-- ---------------------------------------------------------------------------

create table public.metrics_daily (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null check (platform in ('meta', 'google', 'tiktok', 'linkedin', 'ga4', 'other')),
  account_id text not null,
  campaign_id text not null default '',
  campaign_name text,
  day date not null,
  spend_cents bigint not null default 0 check (spend_cents >= 0),
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  leads bigint not null default 0,
  conversions bigint not null default 0,
  revenue_cents bigint not null default 0,
  unique (client_id, platform, account_id, campaign_id, day)
);
create index metrics_daily_agency_client_day on public.metrics_daily (agency_id, client_id, day);
create trigger metrics_daily_client_agency before insert or update on public.metrics_daily
  for each row execute function public.app_check_client_agency();

-- ---------------------------------------------------------------------------
-- Chaves de API das agências (cifradas pelo servidor, AES-256-GCM)
-- ---------------------------------------------------------------------------

create table public.ai_credentials (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai', 'google', 'xai')),
  label text not null check (char_length(label) between 1 and 60),
  ciphertext text not null,
  key_last4 text not null check (char_length(key_last4) <= 4),
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index ai_credentials_agency on public.ai_credentials (agency_id);

-- Preço de tabela por modelo, para estimar e registrar o gasto (US$ por milhão de tokens).
create table public.ai_model_prices (
  provider text not null check (provider in ('anthropic', 'openai', 'google', 'xai')),
  model text not null,
  input_usd_per_mtok numeric(12, 6) not null check (input_usd_per_mtok >= 0),
  output_usd_per_mtok numeric(12, 6) not null check (output_usd_per_mtok >= 0),
  cache_read_usd_per_mtok numeric(12, 6),
  pricing_version text not null,
  primary key (provider, model)
);

-- Preços de tabela da Anthropic (outubro de 2026). Os demais provedores entram pelo admin.
insert into public.ai_model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, pricing_version) values
  ('anthropic', 'claude-opus-5-5', 4.00, 20.00, 0.20, '2026-10-06'),
  ('anthropic', 'claude-sonnet-5-5', 2.00, 10.00, 0.20, '2026-10-06'),
  ('anthropic', 'claude-haiku-5-5', 0.10, 0.50, null, '2026-10-06');

-- ---------------------------------------------------------------------------
-- Xodós
-- ---------------------------------------------------------------------------

create table public.xodos (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  species text not null check (species in ('pingo', 'bibo', 'oki')),
  color text not null default 'coral' check (char_length(color) <= 20),
  personality text not null check (personality in ('curioso', 'brincalhao', 'direto', 'zen')),
  role text not null check (role in ('relatorios', 'alertas', 'otimizacao', 'geral')),
  instructions text not null default '' check (char_length(instructions) <= 8000),
  provider text not null check (provider in ('anthropic', 'openai', 'google', 'xai')),
  model text not null,
  credential_id uuid references public.ai_credentials(id) on delete set null,
  daily_budget_usd numeric(10, 4) not null default 2 check (daily_budget_usd > 0),
  warn_at_percent integer not null default 80 check (warn_at_percent between 1 and 99),
  timezone text not null default 'America/Sao_Paulo',
  status text not null default 'active' check (status in ('active', 'paused')),
  client_scope text not null default 'all' check (client_scope in ('all', 'selected')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, name)
);

-- Clientes que o xodó pode atender quando client_scope = 'selected'.
create table public.xodo_clients (
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  primary key (xodo_id, client_id)
);
create trigger xodo_clients_client_agency before insert or update on public.xodo_clients
  for each row execute function public.app_check_client_agency();

-- Ferramentas liberadas para cada xodó (lista explícita).
create table public.xodo_tools (
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  tool_name text not null,
  enabled boolean not null default true,
  primary key (xodo_id, tool_name)
);

-- Regras de aprovação: valem para a agência inteira (xodo_id nulo) ou para um xodó.
-- "require_approval" sempre vence "always_allow", em qualquer nível.
create table public.approval_rules (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  xodo_id uuid references public.xodos(id) on delete cascade,
  effect text not null check (effect in ('always_allow', 'require_approval')),
  match_kind text not null check (match_kind in ('tool', 'category')),
  match_value text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index approval_rules_agency on public.approval_rules (agency_id);

-- Memória por xodó: um texto curto carregado em cada conversa, com histórico para desfazer.
create table public.xodo_memories (
  xodo_id uuid primary key references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  content text not null default '' check (char_length(content) <= 24000),
  updated_at timestamptz not null default now()
);
create table public.xodo_memory_revisions (
  id bigint generated always as identity primary key,
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  content text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

-- Execuções. native_messages guarda a conversa no formato do provedor para retomar
-- depois de uma aprovação; nunca é exposta às pessoas.
create table public.xodo_runs (
  id uuid primary key default gen_random_uuid(),
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  trigger text not null check (trigger in ('user', 'routine')),
  routine_id uuid,
  requested_by uuid,
  status text not null default 'running'
    check (status in ('running', 'waiting_approval', 'completed', 'failed', 'paused_budget', 'refused')),
  provider text not null,
  model text not null,
  native_messages jsonb not null default '[]'::jsonb,
  steps integer not null default 0,
  tool_calls integer not null default 0,
  final_text text,
  error text,
  started_at timestamptz not null default now(),
  -- Atualizado a cada passo; uma execução "running" sem sinal há muito tempo travou.
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz
);
create index xodo_runs_xodo on public.xodo_runs (xodo_id, started_at desc);

-- A conversa visível do xodó (uma só por xodó, como no design).
create table public.xodo_messages (
  id bigint generated always as identity primary key,
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  run_id uuid references public.xodo_runs(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'note')),
  author_user uuid,
  text text not null,
  created_at timestamptz not null default now()
);
create index xodo_messages_xodo on public.xodo_messages (xodo_id, id);

-- Cada ação pedida por um xodó. O servidor executa só o input guardado aqui, uma única vez.
-- step e call_index guardam a ordem em que o modelo pediu, para devolver os resultados na mesma ordem.
create table public.xodo_actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.xodo_runs(id) on delete cascade,
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  tool_name text not null,
  category text not null,
  tool_call_id text not null,
  step integer not null,
  call_index integer not null,
  input jsonb not null,
  input_hash text not null,
  status text not null
    check (status in ('pending', 'approved', 'denied', 'executing', 'executed', 'failed', 'expired')),
  reason text,
  decision text check (decision in ('once', 'always')),
  decided_by uuid,
  decided_at timestamptz,
  expires_at timestamptz,
  result jsonb,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, tool_call_id)
);
create index xodo_actions_pending on public.xodo_actions (agency_id, status) where status = 'pending';

-- Livro de gastos: uma linha por chamada de modelo. xodo_id sem FK para sobreviver à exclusão.
create table public.ai_usage (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  xodo_id uuid,
  run_id uuid,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  cost_source text not null check (cost_source in ('list_price', 'unknown')),
  pricing_version text,
  call_id text not null unique,
  day date not null,
  created_at timestamptz not null default now()
);
create index ai_usage_agency_day on public.ai_usage (agency_id, day);

-- Teto diário por xodó: o gasto confirmado e o reservado pelas chamadas em andamento.
create table public.xodo_budget_days (
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  day date not null,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  spent_usd numeric(12, 6) not null default 0,
  reserved_usd numeric(12, 6) not null default 0 check (reserved_usd >= 0),
  warned_at timestamptz,
  capped_at timestamptz,
  primary key (xodo_id, day)
);

-- Rotinas agendadas (ex.: relatório semanal toda segunda às 8h).
create table public.xodo_routines (
  id uuid primary key default gen_random_uuid(),
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  cron text not null,
  timezone text not null default 'America/Sao_Paulo',
  active boolean not null default true,
  continuity boolean not null default true,
  last_summary text,
  last_run_id uuid,
  last_run_at timestamptz,
  next_run_at timestamptz,
  locked_until timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index xodo_routines_due on public.xodo_routines (next_run_at) where active;

-- Avisos para a equipe (aprovação pendente, gasto em 80%, xodó pausado).
create table public.notifications (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid,
  kind text not null,
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_agency on public.notifications (agency_id, created_at desc);

-- Relatórios: rascunho feito pela equipe ou por um xodó; só vão ao portal depois de aprovados.
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  title text not null check (char_length(title) between 1 and 160),
  body_md text not null default '' check (char_length(body_md) <= 60000),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by_user uuid,
  created_by_xodo uuid references public.xodos(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reports_agency_client on public.reports (agency_id, client_id, created_at desc);
create trigger reports_client_agency before insert or update on public.reports
  for each row execute function public.app_check_client_agency();

-- ---------------------------------------------------------------------------
-- Reserva e acerto do teto diário (atômicos, com trava de linha)
-- ---------------------------------------------------------------------------

-- Reserva o pior caso de uma chamada antes de ela começar. Se não couber no teto,
-- recusa e marca o dia como estourado: o xodó termina o passo atual e pausa.
create or replace function public.xodo_budget_reserve(p_xodo uuid, p_day date, p_estimate numeric)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_cap numeric;
  v_agency uuid;
  v_row public.xodo_budget_days;
  v_first_cap boolean;
begin
  select daily_budget_usd, agency_id into v_cap, v_agency from public.xodos where id = p_xodo;
  if v_cap is null then
    raise exception 'xodó % não existe', p_xodo;
  end if;
  insert into public.xodo_budget_days (xodo_id, day, agency_id) values (p_xodo, p_day, v_agency)
    on conflict (xodo_id, day) do nothing;
  select * into v_row from public.xodo_budget_days where xodo_id = p_xodo and day = p_day for update;
  if v_row.spent_usd + v_row.reserved_usd + p_estimate > v_cap then
    v_first_cap := v_row.capped_at is null;
    update public.xodo_budget_days set capped_at = coalesce(capped_at, now())
      where xodo_id = p_xodo and day = p_day;
    return jsonb_build_object('ok', false, 'spent', v_row.spent_usd, 'reserved', v_row.reserved_usd,
      'cap', v_cap, 'first_cap', v_first_cap);
  end if;
  update public.xodo_budget_days set reserved_usd = reserved_usd + p_estimate
    where xodo_id = p_xodo and day = p_day;
  return jsonb_build_object('ok', true, 'spent', v_row.spent_usd, 'reserved', v_row.reserved_usd + p_estimate,
    'cap', v_cap, 'first_cap', false);
end;
$$;

-- Libera a reserva e soma o custo real. Avisa uma única vez ao cruzar o percentual de aviso.
create or replace function public.xodo_budget_settle(p_xodo uuid, p_day date, p_reserved numeric, p_actual numeric)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_cap numeric;
  v_warn integer;
  v_row public.xodo_budget_days;
  v_warn_now boolean := false;
begin
  select daily_budget_usd, warn_at_percent into v_cap, v_warn from public.xodos where id = p_xodo;
  update public.xodo_budget_days
     set reserved_usd = greatest(0, reserved_usd - p_reserved),
         spent_usd = spent_usd + p_actual
   where xodo_id = p_xodo and day = p_day
   returning * into v_row;
  if v_row.warned_at is null and v_row.spent_usd >= v_cap * v_warn / 100.0 then
    update public.xodo_budget_days set warned_at = now() where xodo_id = p_xodo and day = p_day;
    v_warn_now := true;
  end if;
  return jsonb_build_object('spent', v_row.spent_usd, 'cap', v_cap, 'warn_now', v_warn_now);
end;
$$;

-- Pega as rotinas vencidas que não estão rodando (pula sobreposição) e trava por 15 minutos.
create or replace function public.xodo_claim_due_routines(p_now timestamptz, p_limit integer)
returns setof public.xodo_routines language sql set search_path = public as $$
  update public.xodo_routines r
     set locked_until = p_now + interval '15 minutes'
   where r.id in (
     select id from public.xodo_routines
      where active and next_run_at is not null and next_run_at <= p_now
        and (locked_until is null or locked_until < p_now)
      order by next_run_at
      limit p_limit
      for update skip locked
   )
  returning r.*;
$$;

-- ---------------------------------------------------------------------------
-- Acesso: pessoas logadas só leem, e só a própria agência
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'metrics_daily', 'ai_credentials', 'xodos', 'xodo_clients', 'xodo_tools', 'approval_rules',
    'xodo_memories', 'xodo_memory_revisions', 'xodo_runs', 'xodo_messages', 'xodo_actions',
    'ai_usage', 'xodo_budget_days', 'xodo_routines', 'notifications', 'reports'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.app_is_agency_member(agency_id))',
      t || '_member_read', t);
  end loop;
end;
$$;

-- Leitura só das colunas seguras: a chave cifrada e a conversa interna nunca chegam ao navegador.
grant select (id, agency_id, provider, label, key_last4, created_by, created_at, revoked_at)
  on public.ai_credentials to authenticated;
grant select (id, xodo_id, agency_id, trigger, routine_id, requested_by, status, provider, model,
  steps, tool_calls, final_text, error, started_at, heartbeat_at, finished_at)
  on public.xodo_runs to authenticated;
grant select on public.metrics_daily, public.xodos, public.xodo_clients, public.xodo_tools,
  public.approval_rules, public.xodo_memories, public.xodo_memory_revisions, public.xodo_messages,
  public.xodo_actions, public.ai_usage, public.xodo_budget_days, public.xodo_routines,
  public.reports to authenticated;
-- Avisos: os gerais da agência e os endereçados à própria pessoa.
grant select on public.notifications to authenticated;
drop policy notifications_member_read on public.notifications;
create policy notifications_member_read on public.notifications for select to authenticated
  using (public.app_is_agency_member(agency_id) and (user_id is null or user_id = auth.uid()));

-- Preços de modelo são públicos para quem está logado.
alter table public.ai_model_prices enable row level security;
revoke all on public.ai_model_prices from anon, authenticated;
grant select on public.ai_model_prices to authenticated;
create policy ai_model_prices_read on public.ai_model_prices for select to authenticated using (true);
