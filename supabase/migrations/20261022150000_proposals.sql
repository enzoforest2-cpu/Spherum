-- Propostas comerciais: o documento do editor (itens, condições, aparência, aditivos) fica em doc;
-- o servidor cuida do status, do link público (token), das visualizações e do aceite.
-- Aceite eletrônico: nome, e-mail, data/hora e IP de quem aceitou. Aceitar cria o cliente (se
-- precisar) e o contrato com a mensalidade.
-- O navegador só lê (RLS, só a equipe); o cliente vê a proposta pelo link, via servidor.

alter table public.agencies add column proposal_catalog jsonb;

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  number int not null,
  deal_id uuid references public.deals(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  company text not null check (char_length(company) between 1 and 160),
  contact_name text check (char_length(contact_name) <= 120),
  email text check (char_length(email) <= 254),
  phone text check (char_length(phone) <= 40),
  source text check (char_length(source) <= 40),
  status text not null default 'rascunho' check (status in ('rascunho', 'enviada', 'aceita', 'recusada')),
  doc jsonb not null default '{}'::jsonb check (pg_column_size(doc) <= 200000),
  monthly_cents bigint not null default 0 check (monthly_cents between 0 and 100000000),
  one_time_cents bigint not null default 0 check (one_time_cents between 0 and 100000000),
  term_months int not null default 6 check (term_months between 1 and 60),
  valid_until date,
  -- Guardamos só o hash do token do link público.
  token_hash text unique,
  sent_at timestamptz,
  views int not null default 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  accepted_at timestamptz,
  accepted_name text check (char_length(accepted_name) <= 120),
  accepted_email text check (char_length(accepted_email) <= 254),
  accepted_ip text check (char_length(accepted_ip) <= 64),
  declined_at timestamptz,
  decline_reason text check (char_length(decline_reason) <= 500),
  contract_id uuid references public.client_contracts(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, number)
);
create index proposals_agency on public.proposals (agency_id, created_at desc);
create trigger proposals_touch before update on public.proposals for each row execute function public.app_touch_updated_at();

alter table public.proposals enable row level security;
create policy proposals_read on public.proposals for select to authenticated using (public.app_is_agency_member(agency_id));
grant select (id, agency_id, number, deal_id, client_id, company, contact_name, email, phone, source, status, doc, monthly_cents, one_time_cents, term_months,
  valid_until, sent_at, views, first_viewed_at, last_viewed_at, accepted_at, accepted_name, accepted_email, declined_at, decline_reason, contract_id, created_at, updated_at)
  on public.proposals to authenticated;
