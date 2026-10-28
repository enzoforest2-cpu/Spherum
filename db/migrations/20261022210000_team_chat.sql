-- Chat da equipe: canais (por assunto ou por cliente), conversas diretas, mensagens e leitura.
-- O navegador só lê (RLS: equipe da agência; direta só as duas pessoas); toda escrita passa pelo servidor.

create table public.team_channels (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  kind text not null check (kind in ('canal', 'cliente', 'direta')),
  name text not null check (char_length(name) between 1 and 60),
  description text check (char_length(description) <= 200),
  client_id uuid references public.clients(id) on delete cascade,
  -- Conversa direta: as duas pessoas, em ordem (member_a < member_b).
  member_a uuid,
  member_b uuid,
  pinned_text text check (char_length(pinned_text) <= 4000),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (kind <> 'direta' or (member_a is not null and member_b is not null and member_a < member_b))
);
create unique index team_channels_name on public.team_channels (agency_id, name) where kind <> 'direta';
create unique index team_channels_dm on public.team_channels (agency_id, member_a, member_b) where kind = 'direta';

create table public.team_messages (
  id bigint generated always as identity primary key,
  channel_id uuid not null references public.team_channels(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  author_user uuid,
  -- Aviso do Spherum (ex.: pedido entregue a um xodó).
  system boolean not null default false,
  text text not null check (char_length(text) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index team_messages_channel on public.team_messages (channel_id, id desc);

create table public.team_reads (
  channel_id uuid not null references public.team_channels(id) on delete cascade,
  user_id uuid not null,
  last_read_id bigint not null default 0,
  primary key (channel_id, user_id)
);

create or replace function public.app_can_see_channel(p_channel uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_channels c
     where c.id = p_channel and public.app_is_agency_member(c.agency_id)
       and (c.kind <> 'direta' or auth.uid() in (c.member_a, c.member_b))
  );
$$;
revoke execute on function public.app_can_see_channel(uuid) from public, anon;

alter table public.team_channels enable row level security;
alter table public.team_messages enable row level security;
alter table public.team_reads enable row level security;
create policy team_channels_read on public.team_channels for select to authenticated using (public.app_can_see_channel(id));
create policy team_messages_read on public.team_messages for select to authenticated using (public.app_can_see_channel(channel_id));
create policy team_reads_read on public.team_reads for select to authenticated using (user_id = auth.uid());
grant select on public.team_channels, public.team_messages, public.team_reads to authenticated;
