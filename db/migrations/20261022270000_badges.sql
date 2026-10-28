-- Conquistas: pontos por entregas medidas no Spherum, reconhecimentos entre colegas, emblemas do mês
-- e um desafio da equipe. A configuração (pontos por regra, ranking visível, desafio) fica na agência.
-- O navegador só lê (RLS); a escrita passa pelo servidor.

alter table public.agencies add column badge_config jsonb not null default '{}'::jsonb
  check (jsonb_typeof(badge_config) = 'object' and pg_column_size(badge_config) <= 8000);

create table public.kudos (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  from_user uuid not null,
  to_user uuid not null check (to_user <> from_user),
  text text not null check (char_length(text) between 3 and 500),
  created_at timestamptz not null default now()
);
create index kudos_agency on public.kudos (agency_id, created_at desc);

alter table public.kudos enable row level security;
create policy kudos_read on public.kudos for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.kudos to authenticated;
