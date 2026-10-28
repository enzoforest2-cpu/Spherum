-- Admin do Spherum: suspensão de agência, funil de leads, cupons, comunicados, status da plataforma,
-- execuções do cron e chamados de suporte das agências para o Spherum. Tudo é lido e gravado pelo
-- servidor (rotas /api/admin, só para a equipe do Spherum); o navegador não acessa estas tabelas.

-- Papéis da equipe: dono, operação, suporte, financeiro e leitura.
alter table public.spherum_staff drop constraint if exists spherum_staff_role_check;
alter table public.spherum_staff add constraint spherum_staff_role_check check (role in ('dono', 'operacao', 'suporte', 'financeiro', 'leitura'));
alter table public.spherum_staff add column if not exists invited_by uuid references auth.users(id) on delete set null;

-- Agência suspensa: a equipe e os clientes dela perdem o acesso até a reativação. Os dados ficam.
alter table public.agencies add column if not exists suspended_at timestamptz;
alter table public.agencies add column if not exists suspended_reason text check (char_length(suspended_reason) <= 500);

-- Leads do site viram um funil da equipe do Spherum.
alter table public.site_leads add column if not exists stage text not null default 'new'
  check (stage in ('new', 'contacted', 'demo', 'trial', 'won', 'lost'));
alter table public.site_leads add column if not exists owner_user uuid references auth.users(id) on delete set null;
alter table public.site_leads add column if not exists note text check (char_length(note) <= 2000);
update public.site_leads set stage = 'contacted' where handled_at is not null and stage = 'new';

-- Cupons (valem quando a assinatura do Spherum existir; o cadastro já guarda o cupom usado).
create table public.coupons (
  code text primary key check (code ~ '^[A-Z0-9]{3,24}$'),
  description text not null check (char_length(description) between 3 and 200),
  kind text not null check (kind in ('pct', 'brl')),
  value numeric(10, 2) not null check (value > 0),
  months integer not null default 1 check (months between 1 and 36),
  plans text[] not null default '{}',
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0,
  valid_until date,
  status text not null default 'active' check (status in ('active', 'paused')),
  note text check (char_length(note) <= 300),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (kind <> 'pct' or value <= 100)
);
alter table public.coupons enable row level security;

-- Comunicados para as agências (aviso no app e, se escolhido, e-mail para os donos e admins).
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 3 and 160),
  body text not null check (char_length(body) between 3 and 4000),
  channel text not null default 'banner' check (channel in ('banner', 'email', 'both')),
  segment text not null default 'all' check (segment ~ '^(all|paid|trial|xodo|plan:(solo|agencia|escala|rede|empresarial))$'),
  cta_label text check (char_length(cta_label) <= 40),
  cta_url text check (cta_url ~ '^https://' and char_length(cta_url) <= 500),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sent')),
  send_at timestamptz,
  sent_at timestamptz,
  reach integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index announcements_due on public.announcements (send_at) where status = 'scheduled';
alter table public.announcements enable row level security;

-- Status da plataforma: incidentes abertos pela equipe, com atualizações.
create table public.status_incidents (
  id uuid primary key default gen_random_uuid(),
  service text not null check (service in ('app', 'meta', 'google', 'wa', 'xodo', 'pay')),
  title text not null check (char_length(title) between 3 and 160),
  severity text not null default 'minor' check (severity in ('minor', 'major', 'critical')),
  status text not null default 'investigating' check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null
);
create table public.status_updates (
  id bigint generated always as identity primary key,
  incident_id uuid not null references public.status_incidents(id) on delete cascade,
  status text not null check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  text text not null check (char_length(text) between 3 and 2000),
  author_user uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index status_updates_incident on public.status_updates (incident_id, created_at desc);
alter table public.status_incidents enable row level security;
alter table public.status_updates enable row level security;

-- Cada execução do agendador: etapas que falharam e o resultado (o admin mostra a saúde por serviço).
create table public.cron_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  failed text[] not null default '{}',
  result jsonb not null default '{}'::jsonb
);
create index cron_runs_started on public.cron_runs (started_at desc);
alter table public.cron_runs enable row level security;

-- Chamados das agências para o suporte do Spherum.
create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  opened_by uuid references auth.users(id) on delete set null,
  subject text not null check (char_length(subject) between 3 and 160),
  priority text not null default 'media' check (priority in ('alta', 'media', 'baixa')),
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.support_messages (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  side text not null check (side in ('ag', 'sp')),
  author_user uuid references auth.users(id) on delete set null,
  text text not null check (char_length(text) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index support_tickets_agency on public.support_tickets (agency_id, created_at desc);
create index support_tickets_open on public.support_tickets (status, updated_at desc);
create index support_messages_ticket on public.support_messages (ticket_id, id);
create trigger support_tickets_touch before update on public.support_tickets for each row execute function public.app_touch_updated_at();
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
