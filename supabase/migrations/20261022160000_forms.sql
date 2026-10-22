-- Formulários: o lead responde por um link público e vira negócio no CRM (na etapa escolhida).
-- Os campos ficam em fields (texto, telefone, e-mail, escolha, com condição opcional).
-- O navegador só lê (RLS); o público responde pelo servidor.

create table public.forms (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  code text not null unique check (code ~ '^[a-z0-9]{8,16}$'),
  name text not null check (char_length(name) between 1 and 120),
  fields jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array' and pg_column_size(fields) <= 50000),
  cta text not null default 'Enviar' check (char_length(cta) between 1 and 60),
  thanks text check (char_length(thanks) <= 300),
  -- Etapa do CRM em que a resposta entra e quem é o responsável.
  deal_stage text not null default 'novo' check (deal_stage in ('novo', 'contato', 'diagnostico')),
  owner_user uuid,
  notify boolean not null default true,
  active boolean not null default true,
  views int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index forms_agency on public.forms (agency_id);
create trigger forms_touch before update on public.forms for each row execute function public.app_touch_updated_at();

create table public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.forms(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  answers jsonb not null check (pg_column_size(answers) <= 20000),
  deal_id uuid references public.deals(id) on delete set null,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index form_submissions_form on public.form_submissions (form_id, created_at desc);

alter table public.forms enable row level security;
alter table public.form_submissions enable row level security;
create policy forms_read on public.forms for select to authenticated using (public.app_is_agency_member(agency_id));
create policy form_submissions_read on public.form_submissions for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.forms to authenticated;
grant select (id, form_id, agency_id, answers, deal_id, created_at) on public.form_submissions to authenticated;
