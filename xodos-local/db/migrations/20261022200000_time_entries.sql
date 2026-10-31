-- Rentabilidade: horas da equipe por cliente (registradas à mão ou ao concluir tarefa) e o custo
-- por hora da agência. O navegador só lê (RLS); toda escrita passa pelo servidor.

alter table public.agencies add column cost_per_hour numeric(8, 2) not null default 85 check (cost_per_hour between 10 and 2000);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  client_id uuid,
  project_id uuid references public.projects(id) on delete set null,
  category text not null check (category in ('trafego', 'criativos', 'reunioes', 'relatorios', 'outros')),
  minutes int not null check (minutes between 1 and 1440),
  day date not null,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index time_entries_agency on public.time_entries (agency_id, day desc);

alter table public.time_entries enable row level security;
create policy time_entries_read on public.time_entries for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.time_entries to authenticated;
