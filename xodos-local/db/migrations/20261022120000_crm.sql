-- CRM: o funil de vendas da agência. Negócio ganho vira cliente (com onboarding, contrato e portal).
-- Etapas: novo, contato, diagnostico, proposta, negociacao (abertas), ganho, perdido (fechadas).
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  company text not null check (char_length(company) between 1 and 160),
  contact_name text check (char_length(contact_name) <= 120),
  email text check (char_length(email) <= 254),
  phone text check (char_length(phone) <= 40),
  segment text check (char_length(segment) <= 80),
  website text check (char_length(website) <= 200),
  source text check (char_length(source) <= 40),
  -- Valor mensal estimado do contrato.
  value_cents bigint not null default 0 check (value_cents between 0 and 100000000),
  stage text not null default 'novo' check (stage in ('novo', 'contato', 'diagnostico', 'proposta', 'negociacao', 'ganho', 'perdido')),
  owner_user uuid,
  next_action text check (char_length(next_action) <= 200),
  next_action_date date,
  last_contact_at timestamptz,
  stage_changed_at timestamptz not null default now(),
  notes text check (char_length(notes) <= 4000),
  lost_reason text check (char_length(lost_reason) <= 300),
  won_at timestamptz,
  lost_at timestamptz,
  client_id uuid references public.clients(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deals_agency on public.deals (agency_id, stage);
create trigger deals_touch before update on public.deals for each row execute function public.app_touch_updated_at();

alter table public.deals enable row level security;
create policy deals_read on public.deals for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.deals to authenticated;
