-- Prospecção: listas próprias da agência (planilha ou números colados), cadência pelo WhatsApp
-- oficial com modelos aprovados pela Meta, opt-out permanente e respostas em Conversas.
-- O navegador só lê (RLS); envios e respostas passam pelo servidor.

alter table public.agencies add column prospect_config jsonb not null default '{}'::jsonb
  check (jsonb_typeof(prospect_config) = 'object' and pg_column_size(prospect_config) <= 60000);

create table public.prospect_leads (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  list_name text not null check (char_length(list_name) between 1 and 80),
  name text check (char_length(name) <= 120),
  company text check (char_length(company) <= 160),
  -- Só dígitos, com o 55 do Brasil.
  phone text not null check (phone ~ '^55\d{10,11}$'),
  email text check (char_length(email) <= 254),
  segment text check (char_length(segment) <= 80),
  city text check (char_length(city) <= 80),
  source text not null default 'planilha' check (source in ('planilha', 'colado', 'manual', 'formulario')),
  stage text not null default 'novo' check (stage in ('novo', 'fila', 'abordado', 'respondeu', 'qualificado', 'reuniao', 'crm', 'saiu', 'erro')),
  -- Próximo passo da cadência e quando ele sai.
  step int not null default 0 check (step between 0 and 10),
  next_at timestamptz,
  variation int,
  last_out_at timestamptz,
  last_in_at timestamptz,
  read_at timestamptz,
  owner_user uuid,
  deal_id uuid references public.deals(id) on delete set null,
  error text check (char_length(error) <= 400),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, phone)
);
create index prospect_leads_due on public.prospect_leads (agency_id, next_at) where stage in ('fila', 'abordado');
create trigger prospect_leads_touch before update on public.prospect_leads for each row execute function public.app_touch_updated_at();

create table public.prospect_messages (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.prospect_leads(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  dir text not null check (dir in ('out', 'in', 'note', 'sys')),
  text text not null check (char_length(text) between 1 and 4096),
  -- Passo e variação da cadência (nulo nas respostas manuais).
  step int,
  variation int,
  author_user uuid,
  wa_event_id text unique,
  created_at timestamptz not null default now()
);
create index prospect_messages_lead on public.prospect_messages (lead_id, id);
create index prospect_messages_day on public.prospect_messages (agency_id, created_at) where dir = 'out' and step is not null;

-- Quem pediu para sair não recebe mais nada da agência, nem se for importado de novo.
create table public.prospect_optouts (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  phone text not null,
  created_at timestamptz not null default now(),
  primary key (agency_id, phone)
);

alter table public.prospect_leads enable row level security;
alter table public.prospect_messages enable row level security;
alter table public.prospect_optouts enable row level security;
create policy prospect_leads_read on public.prospect_leads for select to authenticated using (public.app_is_agency_member(agency_id));
create policy prospect_messages_read on public.prospect_messages for select to authenticated using (public.app_is_agency_member(agency_id));
create policy prospect_optouts_read on public.prospect_optouts for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.prospect_leads, public.prospect_optouts to authenticated;
grant select (id, lead_id, agency_id, dir, text, step, variation, author_user, created_at) on public.prospect_messages to authenticated;
