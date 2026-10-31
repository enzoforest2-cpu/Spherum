-- Integrações dos Xodós: conexões de cada agência com apps e plataformas de anúncio.
--
-- Depende da migração dos Xodós (20261018120000_xodos.sql). O login é o OAuth próprio do
-- Spherum (o app do Spherum em cada plataforma); os tokens ficam cifrados pelo servidor e
-- nunca chegam ao navegador.

-- ---------------------------------------------------------------------------
-- Conexões
-- ---------------------------------------------------------------------------

-- provider: google, meta, tiktok, slack, notion, github, telegram, whatsapp_cloud,
-- whatsapp_qr ou mcp. Uma conexão do Google serve Gmail, Agenda, Drive, Google Ads e GA4,
-- conforme as permissões concedidas (scopes).
create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  label text not null check (char_length(label) between 1 and 120),
  -- Quem conectou do outro lado (e-mail do Google, nome do workspace do Slack…).
  external_account text,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'error', 'expired', 'revoked')),
  -- Tokens e segredos (JSON cifrado com AES-256-GCM).
  ciphertext text not null,
  token_expires_at timestamptz,
  -- Dados não secretos: id do workspace, número do WhatsApp, URL de um servidor MCP…
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index integration_connections_agency on public.integration_connections (agency_id, provider);
create unique index integration_connections_account
  on public.integration_connections (agency_id, provider, external_account)
  where status <> 'revoked' and external_account is not null;

-- Pedidos de login em andamento: o state do OAuth é de uso único e vence em 10 minutos.
create table public.oauth_states (
  state text primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  provider text not null,
  apps text[] not null default '{}',
  code_verifier text,
  return_to text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Apps que cada xodó pode usar ("Pode mexer em" no assistente do design). Sem conexão fixada,
-- usa a conexão ativa mais recente da agência para aquele app.
create table public.xodo_apps (
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  app text not null check (char_length(app) between 1 and 40),
  connection_id uuid references public.integration_connections(id) on delete set null,
  primary key (xodo_id, app)
);

-- Contas de anúncio e propriedades de análise de cada cliente (para sincronizar métricas).
create table public.client_ad_accounts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null check (platform in ('meta', 'google', 'tiktok', 'ga4', 'linkedin')),
  external_id text not null check (char_length(external_id) between 1 and 80),
  name text,
  currency text,
  connection_id uuid references public.integration_connections(id) on delete set null,
  -- Dados da plataforma (ex.: login-customer-id do Google Ads quando a conta é de uma MCC).
  metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  unique (agency_id, platform, external_id)
);
create index client_ad_accounts_client on public.client_ad_accounts (client_id);
create trigger client_ad_accounts_client_agency before insert or update on public.client_ad_accounts
  for each row execute function public.app_check_client_agency();

-- Dados do Google Analytics 4 por dia e canal. Separado das métricas de mídia para sessões
-- não se misturarem com cliques de anúncio.
create table public.analytics_daily (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  property_id text not null,
  day date not null,
  channel text not null default '',
  sessions bigint not null default 0,
  users bigint not null default 0,
  key_events numeric(14, 2) not null default 0,
  revenue_cents bigint not null default 0,
  unique (client_id, property_id, day, channel)
);
create index analytics_daily_agency_client_day on public.analytics_daily (agency_id, client_id, day);
create trigger analytics_daily_client_agency before insert or update on public.analytics_daily
  for each row execute function public.app_check_client_agency();

-- Limites de campanha por xodó ("sozinha até o limite que você definir", no design).
-- Dentro do limite, vale a autonomia; acima dele, a ação sempre pede aprovação.
alter table public.xodos
  add column campaign_max_change_pct integer not null default 20 check (campaign_max_change_pct between 1 and 1000),
  add column campaign_max_daily_brl numeric(12, 2) check (campaign_max_daily_brl > 0);

-- ---------------------------------------------------------------------------
-- Acesso: pessoas logadas só leem, e só a própria agência
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['integration_connections', 'oauth_states', 'xodo_apps', 'client_ad_accounts', 'analytics_daily'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.app_is_agency_member(agency_id))',
      t || '_member_read', t);
  end loop;
end;
$$;

-- Os tokens cifrados não são legíveis nem por quem está logado; os estados de OAuth também não.
grant select (id, agency_id, provider, label, external_account, scopes, status, token_expires_at, metadata,
  last_error, created_by, created_at, updated_at)
  on public.integration_connections to authenticated;
grant select on public.xodo_apps, public.client_ad_accounts, public.analytics_daily to authenticated;
