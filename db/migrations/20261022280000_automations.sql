-- Automações: gatilho (lido dos módulos pelo cron), condições, esperas e ações.
-- Cada execução guarda o contexto (quem disparou), o passo atual e o registro do que aconteceu.
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

create table public.automations (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  enabled boolean not null default false,
  -- { type, ... } (ex.: formulario, reuniao, etapa_crm, fatura_vence, relatorio_publicado)
  trigger jsonb not null check (jsonb_typeof(trigger) = 'object'),
  -- [{ kind: condicao | espera | acao, type, ... }]
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array' and pg_column_size(steps) <= 30000),
  -- Só eventos depois deste instante disparam (ligar não dispara o passado).
  cursor_at timestamptz,
  runs int not null default 0,
  last_run_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automations_enabled on public.automations (agency_id) where enabled;
create trigger automations_touch before update on public.automations for each row execute function public.app_touch_updated_at();

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.automations(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  -- O que disparou (ex.: booking:<id>); a mesma coisa não dispara duas vezes.
  event_key text not null check (char_length(event_key) <= 200),
  context jsonb not null default '{}'::jsonb check (pg_column_size(context) <= 8000),
  step int not null default 0,
  status text not null default 'pendente' check (status in ('pendente', 'esperando', 'rodando', 'feito', 'parado', 'falhou')),
  resume_at timestamptz,
  log jsonb not null default '[]'::jsonb check (pg_column_size(log) <= 20000),
  error text check (char_length(error) <= 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (automation_id, event_key)
);
create index automation_runs_due on public.automation_runs (resume_at) where status in ('pendente', 'esperando');
create index automation_runs_agency on public.automation_runs (agency_id, updated_at desc);
create trigger automation_runs_touch before update on public.automation_runs for each row execute function public.app_touch_updated_at();

alter table public.automations enable row level security;
alter table public.automation_runs enable row level security;
create policy automations_read on public.automations for select to authenticated using (public.app_is_agency_member(agency_id));
create policy automation_runs_read on public.automation_runs for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.automations, public.automation_runs to authenticated;
