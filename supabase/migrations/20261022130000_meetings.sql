-- Atas de reunião: o que foi decidido com cada cliente, quem faz o quê e até quando.
-- Os passos da equipe viram tarefas em Projetos ("Combinados · cliente") quando a equipe pede.
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  meeting_date date not null,
  meeting_time text check (meeting_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  attendees text[] not null default '{}',
  summary text check (char_length(summary) <= 4000),
  decisions text[] not null default '{}',
  -- sem_ata: reunião registrada, ata ainda não escrita.
  status text not null default 'sem_ata' check (status in ('sem_ata', 'rascunho', 'enviada')),
  written_by_xodo uuid references public.xodos(id) on delete set null,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index meetings_agency on public.meetings (agency_id, meeting_date desc);
create trigger meetings_touch before update on public.meetings for each row execute function public.app_touch_updated_at();

create table public.meeting_steps (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  -- Da equipe (owner_user) ou de fora (owner_name, ex.: alguém do cliente).
  owner_user uuid,
  owner_name text check (char_length(owner_name) <= 120),
  due_date date,
  done boolean not null default false,
  position int not null default 0,
  task_id uuid references public.project_tasks(id) on delete set null,
  created_at timestamptz not null default now()
);
create index meeting_steps_meeting on public.meeting_steps (meeting_id, position);

alter table public.meetings enable row level security;
alter table public.meeting_steps enable row level security;
create policy meetings_read on public.meetings for select to authenticated using (public.app_is_agency_member(agency_id));
create policy meeting_steps_read on public.meeting_steps for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.meetings, public.meeting_steps to authenticated;
