-- Contratos com os clientes: mensalidade, vigência, renovação, pausa e aviso prévio.
-- O contrato manda na mensalidade automática ligada a ele (invoice_recurrences):
--   pausa com "suspender" não gera a fatura, com "metade" gera pela metade, com "manter" gera normal;
--   aviso prévio ou contrato encerrado param de gerar depois da data de saída.
-- Um cliente tem no máximo um contrato em vigor. O navegador só lê (RLS); toda escrita passa pelo servidor.

create table public.client_contracts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  monthly_fee_cents bigint not null check (monthly_fee_cents between 0 and 100000000),
  start_date date not null,
  end_date date not null,
  status text not null default 'ativo' check (status in ('ativo', 'aviso', 'encerrado')),
  pause_from date,
  pause_to date,
  pause_reason text check (char_length(pause_reason) <= 200),
  pause_billing text check (pause_billing in ('suspender', 'metade', 'manter')),
  notice_end date,
  notice_reason text check (char_length(notice_reason) <= 500),
  ended_at timestamptz,
  recurrence_id uuid references public.invoice_recurrences(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  notes text check (char_length(notes) <= 2000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date > start_date),
  check ((pause_from is null) = (pause_to is null) and (pause_from is null) = (pause_billing is null)),
  check (pause_to is null or pause_to > pause_from),
  check (status <> 'aviso' or notice_end is not null),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create unique index client_contracts_one_open on public.client_contracts (client_id) where status <> 'encerrado';
create index client_contracts_agency on public.client_contracts (agency_id, end_date);
create index client_contracts_recurrence on public.client_contracts (recurrence_id) where recurrence_id is not null;
create trigger client_contracts_touch before update on public.client_contracts for each row execute function public.app_touch_updated_at();

alter table public.client_contracts enable row level security;
create policy client_contracts_read on public.client_contracts for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.client_contracts to authenticated;
