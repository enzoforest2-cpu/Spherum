-- API pública (v1) e webhooks de saída, a partir do plano Rede (ou com o add-on "API e webhooks").
-- Tudo aqui é lido e gravado só pelo servidor (RLS ligado, sem políticas): a chave e o segredo
-- nunca chegam ao navegador depois da criação.

-- Chaves de API da agência. Guarda só o sha256 da chave; o prefixo visível ajuda a reconhecer.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  prefix text not null check (char_length(prefix) between 8 and 24),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{read}' check (scopes <@ array['read', 'write']::text[] and cardinality(scopes) > 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_agency on public.api_keys (agency_id, created_at desc);
alter table public.api_keys enable row level security;

-- Limite de taxa: pedidos por chave em cada minuto. O agendador apaga os minutos antigos.
create table public.api_key_hits (
  key_id uuid not null references public.api_keys(id) on delete cascade,
  minute timestamptz not null,
  hits int not null default 0,
  primary key (key_id, minute)
);
create index api_key_hits_minute on public.api_key_hits (minute);
alter table public.api_key_hits enable row level security;

-- Endereços que recebem os eventos. O segredo de assinatura fica cifrado (AES-256-GCM, como as chaves das integrações).
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  url text not null check (char_length(url) between 9 and 500 and url like 'https://%'),
  description text check (char_length(description) <= 120),
  events text[] not null check (cardinality(events) > 0
    and events <@ array['client.created', 'deal.won', 'lead.replied', 'invoice.paid', 'report.published']::text[]),
  secret_ciphertext text not null,
  secret_hint text not null check (char_length(secret_hint) <= 8),
  -- Falhas seguidas (qualquer entrega); zera quando uma entrega dá certo.
  failures int not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text check (char_length(last_error) <= 300),
  disabled_at timestamptz,
  disabled_reason text check (char_length(disabled_reason) <= 300),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index webhook_endpoints_agency on public.webhook_endpoints (agency_id, created_at desc);
alter table public.webhook_endpoints enable row level security;

-- Fila de entregas: uma linha por evento e endereço. body é o JSON exato que vai (e é assinado) em todas as tentativas.
create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  event_id uuid not null,
  event_type text not null,
  body text not null check (char_length(body) <= 200000),
  status text not null default 'pendente' check (status in ('pendente', 'entregue', 'falhou', 'cancelada')),
  attempts int not null default 0,
  next_at timestamptz not null default now(),
  last_status int,
  last_error text check (char_length(last_error) <= 300),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index webhook_deliveries_due on public.webhook_deliveries (next_at) where status = 'pendente';
create index webhook_deliveries_endpoint on public.webhook_deliveries (endpoint_id, created_at desc);
alter table public.webhook_deliveries enable row level security;
