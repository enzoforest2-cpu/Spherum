-- Base mínima que a migração dos Xodós espera do Supabase e da migração base do backend
-- (agencies, agency_members, clients). Só para os testes no PGlite.

create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth to anon, authenticated;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.agency_members (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  primary key (agency_id, user_id)
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null
);
