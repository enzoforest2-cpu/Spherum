-- Assinatura do Spherum: cada agência paga o plano (e os add-ons) ao Spherum pelo Asaas. O
-- servidor gera as faturas, o Asaas cobra (Pix, boleto ou cartão) e avisa o pagamento. Tudo é lido
-- e gravado pelo servidor; o navegador não acessa estas tabelas.

alter table public.agencies add column if not exists billing_customer_id text;
-- CPF ou CNPJ de quem paga (sem pontuação); sem ele vale o CNPJ da agência.
alter table public.agencies add column if not exists billing_document text check (billing_document ~ '^([0-9]{11}|[0-9]{14})$');
alter table public.agencies add column if not exists billing_email text check (billing_email is null or char_length(billing_email) <= 254);
alter table public.agencies add column if not exists current_period_end timestamptz;
alter table public.agencies add column if not exists cancel_at_period_end boolean not null default false;
-- Troca para um plano menor ou outro ciclo: vale a partir do próximo período.
alter table public.agencies add column if not exists pending_plan text check (pending_plan in ('solo', 'agencia', 'escala', 'rede', 'empresarial'));
alter table public.agencies add column if not exists pending_cycle text check (pending_cycle in ('mensal', 'anual'));
-- Preço combinado (plano Empresarial ou negociação), em centavos por mês. Nulo: preço de tabela.
alter table public.agencies add column if not exists custom_price_cents integer check (custom_price_cents is null or custom_price_cents > 0);
-- Bloqueio por cobrança (teste acabou, atraso depois da carência, assinatura cancelada). A equipe
-- ainda entra, vê os dados e paga; não cria nem altera nada, e os xodós e as automações param.
alter table public.agencies add column if not exists locked_at timestamptz;
alter table public.agencies add column if not exists locked_reason text check (locked_reason in ('teste', 'atraso', 'cancelada'));

-- Add-ons contratados (quantidade 1 para os de liga e desliga).
create table public.agency_addons (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,12}$'),
  qty integer not null check (qty between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (agency_id, addon_id)
);
alter table public.agency_addons enable row level security;

-- Cupom usado pela agência: vale nos próximos N meses de fatura.
create table public.coupon_redemptions (
  agency_id uuid primary key references public.agencies(id) on delete cascade,
  coupon_code text not null references public.coupons(code) on delete cascade,
  months_left integer not null check (months_left >= 0),
  created_at timestamptz not null default now()
);
alter table public.coupon_redemptions enable row level security;

-- Faturas do Spherum para as agências.
create table public.spherum_invoices (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  -- periodo: o plano do período; ajuste: diferença proporcional de um upgrade ou add-on no meio do período.
  kind text not null default 'periodo' check (kind in ('periodo', 'ajuste')),
  plan text not null,
  cycle text not null check (cycle in ('mensal', 'anual')),
  period_start date not null,
  period_end date not null,
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array' and pg_column_size(items) <= 8000),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  amount_cents integer not null check (amount_cents >= 0),
  coupon_code text,
  due_date date not null,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'vencido', 'cancelado', 'estornado')),
  charge_id text unique,
  pay_url text,
  pix_code text,
  boleto_line text,
  paid_at timestamptz,
  method text,
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);
-- Uma fatura de período por agência e início de período (o cron não duplica a renovação).
create unique index spherum_invoices_period on public.spherum_invoices (agency_id, period_start) where kind = 'periodo' and status not in ('cancelado', 'estornado');
create index spherum_invoices_agency on public.spherum_invoices (agency_id, created_at desc);
create index spherum_invoices_open on public.spherum_invoices (due_date) where status in ('pendente', 'vencido');
create trigger spherum_invoices_touch before update on public.spherum_invoices for each row execute function public.app_touch_updated_at();
alter table public.spherum_invoices enable row level security;

-- Avisos do Asaas já processados (o mesmo aviso pode chegar mais de uma vez).
create table public.spherum_billing_events (
  event_id text primary key check (char_length(event_id) <= 200),
  received_at timestamptz not null default now()
);
alter table public.spherum_billing_events enable row level security;
