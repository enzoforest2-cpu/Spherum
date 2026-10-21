-- Projetos da agência e as tarefas de cada um (Projetos: lista, quadro, linha do tempo e calendário).
-- O progresso vem das tarefas quando o projeto tem tarefas; sem tarefas, a equipe informa à mão.
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  -- Sem cliente: projeto interno da agência.
  client_id uuid,
  name text not null check (char_length(name) between 1 and 160),
  description text check (char_length(description) <= 4000),
  owner_user uuid,
  status text not null default 'todo' check (status in ('todo', 'doing', 'review', 'done')),
  priority text not null default 'media' check (priority in ('alta', 'media', 'baixa')),
  tags text[] not null default '{}',
  start_date date not null default current_date,
  due_date date not null,
  progress int not null default 0 check (progress between 0 and 100),
  done_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_date >= start_date),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index projects_agency on public.projects (agency_id, due_date);
create index projects_client on public.projects (client_id) where client_id is not null;
create trigger projects_touch before update on public.projects for each row execute function public.app_touch_updated_at();

create table public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  assignee_user uuid,
  due_date date,
  position int not null default 0,
  done boolean not null default false,
  done_at timestamptz,
  done_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_tasks_project on public.project_tasks (project_id, position);
create index project_tasks_open on public.project_tasks (agency_id, assignee_user) where not done;
create trigger project_tasks_touch before update on public.project_tasks for each row execute function public.app_touch_updated_at();

alter table public.projects enable row level security;
alter table public.project_tasks enable row level security;

create policy projects_read on public.projects for select to authenticated using (public.app_is_agency_member(agency_id));
create policy project_tasks_read on public.project_tasks for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.projects, public.project_tasks to authenticated;
