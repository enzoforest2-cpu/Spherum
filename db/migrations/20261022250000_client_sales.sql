-- Retorno: vendas de cada cliente (lançadas pela agência, importadas de planilha ou marcadas pelo
-- cliente no portal), ligadas à campanha quando se sabe, para medir o retorno do anúncio até a venda.
-- O navegador só lê (RLS); a escrita passa pelo servidor.

alter table public.clients add column sales_source text check (sales_source in ('manual', 'planilha', 'portal', 'crm'));

create table public.client_sales (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  sold_on date not null,
  amount_cents bigint not null check (amount_cents between 1 and 100000000000),
  customer text check (char_length(customer) <= 160),
  -- Campanha que trouxe a venda (o id do metrics_daily), quando se sabe.
  campaign_id text check (char_length(campaign_id) <= 120),
  campaign_name text check (char_length(campaign_name) <= 200),
  lead_on date,
  source text not null check (source in ('manual', 'planilha', 'portal', 'crm')),
  -- Pedido/negócio na origem (evita duplicar a mesma venda numa nova importação).
  external_id text check (char_length(external_id) <= 120),
  deal_id uuid references public.deals(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index client_sales_client_day on public.client_sales (client_id, sold_on);
create unique index client_sales_external on public.client_sales (client_id, external_id) where external_id is not null;

alter table public.client_sales enable row level security;
create policy client_sales_read on public.client_sales for select to authenticated
  using (public.app_is_agency_member(agency_id) or public.app_is_client_user(client_id));
grant select on public.client_sales to authenticated;
