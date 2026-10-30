-- Assinatura do Spherum: meses de cupom por fatura (voltam ao cupom se a fatura for cancelada sem
-- pagar) e fila de cobranças do Asaas que precisam ser canceladas (o agendador tenta de novo).

alter table public.spherum_invoices add column if not exists coupon_months integer not null default 0 check (coupon_months >= 0);

create table public.spherum_charge_cancels (
  charge_id text primary key check (char_length(charge_id) <= 200),
  attempts integer not null default 0,
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.spherum_charge_cancels enable row level security;
