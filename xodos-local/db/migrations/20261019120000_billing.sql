-- Cobrança dos clientes da agência: a agência conecta a conta dela num meio de pagamento
-- (Asaas, Mercado Pago, Stripe ou a API Pix do Itaú) e o cliente paga a fatura pelo portal.
-- O dinheiro cai direto na conta da agência; o Spherum só cria a cobrança e acompanha o status.
--
-- Também cria o papel "financeiro" na equipe: cobra e vê o financeiro, sem administrar a agência.

alter table public.agency_members drop constraint agency_members_role_check;
alter table public.agency_members add constraint agency_members_role_check check (role in ('owner', 'admin', 'member', 'viewer', 'financeiro'));
alter table public.invites drop constraint invites_role_check;
alter table public.invites add constraint invites_role_check check (role in ('admin', 'member', 'viewer', 'financeiro', 'cliente'));

-- Conta da agência num meio de pagamento. As credenciais vão cifradas pelo servidor (AES-256-GCM);
-- o navegador nunca lê esta tabela.
create table public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  provider text not null check (provider in ('asaas', 'mercadopago', 'stripe', 'itau')),
  environment text not null default 'producao' check (environment in ('producao', 'teste')),
  label text not null check (char_length(label) between 1 and 120),
  ciphertext text not null,
  key_last4 text check (char_length(key_last4) <= 8),
  -- Parte secreta da URL de aviso do provedor (/api/billing/webhooks/<provider>/<token>).
  webhook_token text not null unique check (char_length(webhook_token) between 32 and 80),
  -- Id do aviso cadastrado no provedor (para apagar ao desconectar).
  webhook_id text,
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'error')),
  last_error text check (char_length(last_error) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, provider)
);
create unique index payment_accounts_default on public.payment_accounts (agency_id) where is_default;
create trigger payment_accounts_touch before update on public.payment_accounts for each row execute function public.app_touch_updated_at();

-- Cliente da agência já cadastrado no provedor (o Asaas pede um cadastro antes da cobrança).
create table public.billing_customers (
  client_id uuid not null references public.clients(id) on delete cascade,
  payment_account_id uuid not null references public.payment_accounts(id) on delete cascade,
  external_id text not null check (char_length(external_id) <= 120),
  created_at timestamptz not null default now(),
  primary key (client_id, payment_account_id)
);

-- Cobrança mensal automática: o servidor gera a fatura alguns dias antes do vencimento.
create table public.invoice_recurrences (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  description text not null check (char_length(description) between 1 and 200),
  amount_cents bigint not null check (amount_cents between 100 and 100000000),
  day_of_month integer not null check (day_of_month between 1 and 28),
  methods text[] not null default '{pix,boleto,cartao}',
  next_due date not null,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index invoice_recurrences_due on public.invoice_recurrences (next_due) where active;
create trigger invoice_recurrences_touch before update on public.invoice_recurrences for each row execute function public.app_touch_updated_at();

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  description text not null check (char_length(description) between 1 and 200),
  amount_cents bigint not null check (amount_cents between 100 and 100000000),
  due_date date not null,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'vencido', 'cancelado', 'estornado')),
  methods text[] not null default '{pix,boleto,cartao}',
  notes text check (char_length(notes) <= 1000),
  recurrence_id uuid references public.invoice_recurrences(id) on delete set null,
  -- Cobrança no provedor (nula quando a agência ainda não conectou um meio de pagamento).
  payment_account_id uuid references public.payment_accounts(id) on delete set null,
  provider text,
  provider_charge_id text,
  payment_url text check (char_length(payment_url) <= 1000),
  pix_code text check (char_length(pix_code) <= 2000),
  boleto_line text check (char_length(boleto_line) <= 120),
  boleto_url text check (char_length(boleto_url) <= 1000),
  charge_error text check (char_length(charge_error) <= 300),
  paid_at timestamptz,
  paid_cents bigint,
  paid_method text,
  -- Pago "por fora" (dinheiro, transferência) e marcado à mão.
  paid_manually boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade,
  unique (provider, provider_charge_id),
  -- Uma fatura por mês de cada recorrência, mesmo com o agendador rodando duas vezes.
  unique (recurrence_id, due_date)
);
create index invoices_agency on public.invoices (agency_id, due_date desc);
create index invoices_client on public.invoices (client_id, due_date desc);
create index invoices_open on public.invoices (due_date) where status in ('pendente', 'vencido');
create trigger invoices_touch before update on public.invoices for each row execute function public.app_touch_updated_at();

-- Avisos já processados (o provedor pode mandar o mesmo aviso mais de uma vez).
create table public.payment_events (
  id bigint generated always as identity primary key,
  payment_account_id uuid references public.payment_accounts(id) on delete set null,
  provider text not null,
  event_id text not null check (char_length(event_id) <= 200),
  invoice_id uuid references public.invoices(id) on delete set null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

alter table public.payment_accounts enable row level security;
alter table public.billing_customers enable row level security;
alter table public.invoice_recurrences enable row level security;
alter table public.invoices enable row level security;
alter table public.payment_events enable row level security;

-- A equipe da agência e quem é do cliente leem as faturas; o resto só o servidor.
create policy invoices_read on public.invoices for select to authenticated using (
  public.app_is_agency_member(agency_id) or public.app_is_client_user(client_id)
);
grant select (id, agency_id, client_id, description, amount_cents, due_date, status, methods, notes, provider, payment_url, pix_code,
              boleto_line, boleto_url, paid_at, paid_cents, paid_method, paid_manually, created_at, updated_at)
  on public.invoices to authenticated;
create policy invoice_recurrences_read on public.invoice_recurrences for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.invoice_recurrences to authenticated;
