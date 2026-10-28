-- Notas e cobranças: NFS-e de cada fatura (emitida por um provedor, hoje a Focus NFe), envio ao
-- cliente e à contabilidade, e a régua de cobrança (lembretes antes e depois do vencimento).
-- O navegador só lê (RLS); toda escrita passa pelo servidor. O token do provedor fica cifrado em
-- integration_connections (provider 'focusnfe').

alter table public.agencies add column fiscal_config jsonb not null default '{}'::jsonb
  check (jsonb_typeof(fiscal_config) = 'object' and pg_column_size(fiscal_config) <= 8000);
-- Tomador da nota (o CNPJ já existe em clients.cnpj).
alter table public.clients add column legal_name text check (char_length(legal_name) <= 200);
alter table public.clients add column billing_email text check (char_length(billing_email) <= 254);

create table public.fiscal_notes (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  invoice_id uuid references public.invoices(id) on delete set null,
  -- Referência no provedor (única), número da nota e código de verificação da prefeitura.
  ref text not null unique check (char_length(ref) <= 60),
  number text check (char_length(number) <= 40),
  verification_code text check (char_length(verification_code) <= 80),
  status text not null default 'pendente' check (status in ('pendente', 'processando', 'emitida', 'erro', 'cancelada')),
  amount_cents bigint not null check (amount_cents > 0),
  description text not null check (char_length(description) between 1 and 2000),
  provider text not null default 'focusnfe',
  pdf_url text check (char_length(pdf_url) <= 1000),
  xml_url text check (char_length(xml_url) <= 1000),
  error text check (char_length(error) <= 1000),
  issued_at timestamptz,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create unique index fiscal_notes_invoice on public.fiscal_notes (invoice_id) where invoice_id is not null and status <> 'cancelada';
create index fiscal_notes_agency on public.fiscal_notes (agency_id, created_at desc);
create index fiscal_notes_open on public.fiscal_notes (status) where status in ('pendente', 'processando');
create trigger fiscal_notes_touch before update on public.fiscal_notes for each row execute function public.app_touch_updated_at();

-- Lembretes da régua já enviados (um de cada tipo por fatura).
create table public.invoice_reminders (
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  kind text not null check (kind in ('d3', 'd0', 'p3', 'p7')),
  sent_at timestamptz not null default now(),
  primary key (invoice_id, kind)
);

alter table public.fiscal_notes enable row level security;
alter table public.invoice_reminders enable row level security;
create policy fiscal_notes_read on public.fiscal_notes for select to authenticated
  using (public.app_is_agency_member(agency_id) or (status = 'emitida' and public.app_is_client_user(client_id)));
create policy invoice_reminders_read on public.invoice_reminders for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.fiscal_notes, public.invoice_reminders to authenticated;
