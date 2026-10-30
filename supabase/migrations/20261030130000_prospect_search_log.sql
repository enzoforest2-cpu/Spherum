-- Registro das buscas pagas da Prospecção (Google Maps, CNPJá, Instagram), para limitar por minuto e
-- por dia e proteger os créditos da agência. Só o servidor lê e grava.
create table public.prospect_search_log (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  source text not null check (source in ('maps', 'cnpj', 'instagram')),
  created_at timestamptz not null default now()
);
create index prospect_search_log_recent on public.prospect_search_log (agency_id, source, created_at desc);
alter table public.prospect_search_log enable row level security;
