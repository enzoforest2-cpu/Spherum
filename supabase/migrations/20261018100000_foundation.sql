-- Base do Spherum: pessoas, agências, equipe, convites, clientes e o que chega pelo site.
--
-- Vem antes de todas as outras migrações (os Xodós dependem de agencies, agency_members e
-- clients). O login é o Supabase Auth; o resto mora aqui. Como nos Xodós, quem está logado
-- só LÊ (sob RLS) e toda escrita passa pelo servidor, que confere o papel da pessoa.

-- ---------------------------------------------------------------------------
-- Funções de apoio
-- ---------------------------------------------------------------------------

create or replace function public.app_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pessoas
-- ---------------------------------------------------------------------------

-- Perfil de cada login (nome e telefone mostrados na equipe). Criado junto com o usuário.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (char_length(full_name) <= 120),
  phone text check (char_length(phone) <= 40),
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles for each row execute function public.app_touch_updated_at();

create or replace function public.app_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    left(nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''), 120),
    left(nullif(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), ''), 40)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.app_handle_new_user();

-- Equipe do próprio Spherum (portal admin).
create table public.spherum_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'suporte' check (role in ('dono', 'suporte', 'financeiro')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Agências e equipe
-- ---------------------------------------------------------------------------

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$'),
  plan text not null default 'agencia' check (plan in ('solo', 'agencia', 'escala', 'rede', 'empresarial')),
  plan_status text not null default 'trial' check (plan_status in ('trial', 'active', 'past_due', 'canceled')),
  trial_ends_at timestamptz default (now() + interval '14 days'),
  billing_cycle text not null default 'mensal' check (billing_cycle in ('mensal', 'anual')),
  cnpj text check (cnpj ~ '^[0-9]{14}$'),
  phone text check (char_length(phone) <= 40),
  website text check (char_length(website) <= 200),
  city text check (char_length(city) <= 80),
  state text check (state ~ '^[A-Z]{2}$'),
  logo_path text,
  brand_color text check (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  timezone text not null default 'America/Sao_Paulo',
  -- Respostas do cadastro em 5 passos (tamanho da equipe, número de clientes, serviços, objetivo).
  onboarding jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger agencies_touch before update on public.agencies for each row execute function public.app_touch_updated_at();

create table public.agency_members (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  title text check (char_length(title) <= 80),
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (agency_id, user_id)
);
create index agency_members_user on public.agency_members (user_id);

-- A pessoa logada é da agência? (as migrações seguintes recriam com o mesmo corpo)
create or replace function public.app_is_agency_member(p_agency uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.agency_members m
    where m.agency_id = p_agency and m.user_id = auth.uid()
  );
$$;

-- Convites por link (equipe da agência ou acesso de um cliente ao portal). Só o hash do token fica aqui.
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  kind text not null default 'equipe' check (kind in ('equipe', 'cliente')),
  client_id uuid,
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  role text not null check (role in ('admin', 'member', 'viewer', 'cliente')),
  token_hash text not null unique,
  invited_by uuid,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'cliente') = (client_id is not null)),
  check ((kind = 'cliente') = (role = 'cliente'))
);
create index invites_agency on public.invites (agency_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Clientes da agência
-- ---------------------------------------------------------------------------

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  segment text check (char_length(segment) <= 80),
  status text not null default 'ativo' check (status in ('ativo', 'onboarding', 'pausado', 'encerrado')),
  -- Mensalidade que a agência cobra do cliente (centavos).
  monthly_fee_cents bigint check (monthly_fee_cents >= 0),
  started_on date,
  website text check (char_length(website) <= 200),
  instagram text check (char_length(instagram) <= 80),
  cnpj text check (cnpj ~ '^[0-9]{11}$|^[0-9]{14}$'),
  city text check (char_length(city) <= 80),
  color text check (color ~ '^#[0-9A-Fa-f]{6}$'),
  logo_path text,
  notes text check (char_length(notes) <= 4000),
  -- Responsável na agência.
  owner_user_id uuid,
  -- Saúde de 0 a 100 com o motivo (calculada pelo servidor; nula até haver dados).
  health_score integer check (health_score between 0 and 100),
  health_reason text check (char_length(health_reason) <= 300),
  health_updated_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clients_agency on public.clients (agency_id, name);
create unique index clients_id_agency on public.clients (id, agency_id);
create trigger clients_touch before update on public.clients for each row execute function public.app_touch_updated_at();

create table public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  email text check (char_length(email) <= 254),
  phone text check (char_length(phone) <= 40),
  role text check (char_length(role) <= 80),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index client_contacts_client on public.client_contacts (client_id);

-- Quem do cliente entra no portal do cliente (vê só o que é dele).
create table public.client_portal_users (
  client_id uuid not null,
  agency_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (client_id, user_id),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index client_portal_users_user on public.client_portal_users (user_id);

alter table public.invites
  add constraint invites_client_fk foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade;

create or replace function public.app_is_client_user(p_client uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.client_portal_users u
    where u.client_id = p_client and u.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Site e auditoria
-- ---------------------------------------------------------------------------

-- Contato, demonstração e cadastros que chegam pelo site público. Só o servidor lê.
create table public.site_leads (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('contato', 'demonstracao', 'cadastro', 'quiz', 'lista_espera')),
  name text check (char_length(name) <= 120),
  email text check (char_length(email) <= 254),
  phone text check (char_length(phone) <= 40),
  company text check (char_length(company) <= 120),
  message text check (char_length(message) <= 4000),
  scheduled_for timestamptz,
  payload jsonb not null default '{}'::jsonb,
  -- Hash do IP com sal do servidor: limita abuso sem guardar o IP.
  ip_hash text,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index site_leads_created on public.site_leads (created_at desc);
create index site_leads_ip on public.site_leads (ip_hash, created_at desc);
create unique index site_leads_demo_slot on public.site_leads (scheduled_for) where kind = 'demonstracao' and handled_at is null;

-- Configurações do site editadas pela equipe do Spherum (ex.: agenda de demonstrações).
create table public.site_settings (
  key text primary key check (key ~ '^[a-z_]{1,40}$'),
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- Registro de ações sensíveis (papéis, convites, exclusões), sem copiar dados pessoais.
create table public.audit_events (
  id bigint generated always as identity primary key,
  agency_id uuid references public.agencies(id) on delete cascade,
  actor_user_id uuid,
  action text not null check (char_length(action) between 1 and 60),
  target_type text check (char_length(target_type) <= 40),
  target_id text check (char_length(target_id) <= 80),
  summary text check (char_length(summary) <= 300),
  created_at timestamptz not null default now()
);
create index audit_events_agency on public.audit_events (agency_id, id desc);

-- ---------------------------------------------------------------------------
-- Acesso: só leitura para quem é da agência (e para o cliente, o que é dele)
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.spherum_staff enable row level security;
alter table public.agencies enable row level security;
alter table public.agency_members enable row level security;
alter table public.invites enable row level security;
alter table public.clients enable row level security;
alter table public.client_contacts enable row level security;
alter table public.client_portal_users enable row level security;
alter table public.site_leads enable row level security;
alter table public.site_settings enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.profiles, public.spherum_staff, public.agencies, public.agency_members, public.invites,
  public.clients, public.client_contacts, public.client_portal_users, public.site_leads, public.site_settings,
  public.audit_events from anon, authenticated;

-- O próprio perfil e o de quem trabalha na mesma agência.
create policy profiles_read on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.agency_members mine join public.agency_members theirs on theirs.agency_id = mine.agency_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.id
  )
);
grant select (id, full_name, avatar_path) on public.profiles to authenticated;

create policy agencies_read on public.agencies for select to authenticated using (
  public.app_is_agency_member(id)
  or exists (select 1 from public.client_portal_users u where u.agency_id = agencies.id and u.user_id = auth.uid())
);
grant select (id, name, slug, plan, plan_status, trial_ends_at, billing_cycle, phone, website, city, state, logo_path,
              brand_color, timezone, created_at) on public.agencies to authenticated;

create policy agency_members_read on public.agency_members for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.agency_members to authenticated;

create policy clients_read on public.clients for select to authenticated using (
  public.app_is_agency_member(agency_id) or public.app_is_client_user(id)
);
grant select on public.clients to authenticated;

create policy client_contacts_read on public.client_contacts for select to authenticated using (
  public.app_is_agency_member(agency_id) or public.app_is_client_user(client_id)
);
grant select on public.client_contacts to authenticated;

create policy client_portal_users_read on public.client_portal_users for select to authenticated using (
  public.app_is_agency_member(agency_id) or user_id = auth.uid()
);
grant select on public.client_portal_users to authenticated;

-- invites, site_leads, site_settings, spherum_staff e audit_events: nenhuma leitura pelo navegador
-- (o que o site público precisa sai pelas rotas da API).
