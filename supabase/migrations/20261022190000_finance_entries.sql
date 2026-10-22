-- DRE: lançamentos de despesa (fixa ou variável) e de outras receitas, avulsos ou recorrentes
-- (repetem todo mês a partir de month até ended_month), e o imposto da agência.
-- A receita das faturas pagas e o custo dos xodós (IA e computador) entram sozinhos no cálculo.

alter table public.agencies add column dre_tax_pct numeric(5, 2) not null default 6 check (dre_tax_pct between 0 and 40);

create table public.finance_entries (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  kind text not null check (kind in ('fixa', 'variavel', 'receita')),
  category text not null check (char_length(category) between 1 and 40),
  description text not null check (char_length(description) between 1 and 160),
  amount_cents bigint not null check (amount_cents between 1 and 1000000000),
  -- Primeiro dia do mês do lançamento.
  month date not null check (extract(day from month) = 1),
  recurring boolean not null default false,
  ended_month date check (ended_month is null or ended_month >= month),
  client_id uuid references public.clients(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index finance_entries_agency on public.finance_entries (agency_id, month);

alter table public.finance_entries enable row level security;
create policy finance_entries_read on public.finance_entries for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.finance_entries to authenticated;
