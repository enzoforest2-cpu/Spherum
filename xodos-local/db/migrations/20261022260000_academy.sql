-- Academy: trilhas de treinamento (aulas com progresso por pessoa), processos (passo a passo da
-- agência, que vira tarefas num projeto) e onboarding de colaborador (checklist com responsáveis).
-- O navegador só lê (RLS: equipe da agência); toda escrita passa pelo servidor.

create table public.academy_items (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  kind text not null check (kind in ('trilha', 'processo', 'onboarding')),
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 1000),
  -- [{ id, title, sub?, url?, group?, owner_user? }]
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array' and pg_column_size(steps) <= 40000),
  -- Onboarding: quem chega, a função e quando começa.
  hire_name text check (char_length(hire_name) <= 120),
  hire_role text check (char_length(hire_role) <= 80),
  start_date date,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index academy_items_agency on public.academy_items (agency_id, kind);
create trigger academy_items_touch before update on public.academy_items for each row execute function public.app_touch_updated_at();

-- Passo feito: nas trilhas, por pessoa; no onboarding, um só (user_id nulo).
create table public.academy_progress (
  item_id uuid not null references public.academy_items(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  step_id text not null,
  user_id uuid,
  done_by uuid,
  done_at timestamptz not null default now()
);
create unique index academy_progress_user on public.academy_progress (item_id, step_id, user_id) where user_id is not null;
create unique index academy_progress_shared on public.academy_progress (item_id, step_id) where user_id is null;

create table public.academy_assignments (
  item_id uuid not null references public.academy_items(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  due_date date,
  assigned_by uuid,
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

alter table public.academy_items enable row level security;
alter table public.academy_progress enable row level security;
alter table public.academy_assignments enable row level security;
create policy academy_items_read on public.academy_items for select to authenticated using (public.app_is_agency_member(agency_id));
create policy academy_progress_read on public.academy_progress for select to authenticated using (public.app_is_agency_member(agency_id));
create policy academy_assignments_read on public.academy_assignments for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.academy_items, public.academy_progress, public.academy_assignments to authenticated;
