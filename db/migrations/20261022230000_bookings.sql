-- Agendamentos: tipos de reunião com página pública (/agenda/<código>), horários livres
-- (descontando a Google Agenda, se conectada), evento com Meet e cancelamento por link.
-- O navegador só lê (RLS); o público agenda e cancela pelo servidor.

create table public.booking_types (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  code text not null unique check (code ~ '^[a-z0-9]{8,16}$'),
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 500),
  duration_min int not null default 30 check (duration_min in (15, 30, 45, 60, 90)),
  color text not null default '#465FFF' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Dias da semana (0 = domingo) e janela de horas, no fuso de Brasília.
  days int[] not null default '{1,2,3,4,5}',
  from_hour int not null default 9 check (from_hour between 0 and 23),
  to_hour int not null default 18 check (to_hour between 1 and 24 and to_hour > from_hour),
  min_notice_hours int not null default 2 check (min_notice_hours between 0 and 168),
  max_days_ahead int not null default 30 check (max_days_ahead between 1 and 90),
  -- Conexão Google com a Agenda: confere os horários ocupados e cria o evento com o Meet.
  connection_id uuid references public.integration_connections(id) on delete set null,
  calendar_id text not null default 'primary' check (char_length(calendar_id) <= 200),
  owner_user uuid,
  create_deal boolean not null default true,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index booking_types_agency on public.booking_types (agency_id);
create trigger booking_types_touch before update on public.booking_types for each row execute function public.app_touch_updated_at();

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  type_id uuid not null references public.booking_types(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) <= 254),
  phone text check (char_length(phone) <= 40),
  notes text check (char_length(notes) <= 1000),
  start_at timestamptz not null,
  end_at timestamptz not null check (end_at > start_at),
  status text not null default 'confirmada' check (status in ('confirmada', 'cancelada')),
  cancelled_by text check (cancelled_by in ('agencia', 'convidado')),
  google_event_id text,
  meet_link text,
  calendar_error text,
  deal_id uuid references public.deals(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  cancel_hash text not null unique,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index bookings_agency_start on public.bookings (agency_id, start_at) where status = 'confirmada';

alter table public.booking_types enable row level security;
alter table public.bookings enable row level security;
create policy booking_types_read on public.booking_types for select to authenticated using (public.app_is_agency_member(agency_id));
create policy bookings_read on public.bookings for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.booking_types to authenticated;
grant select (id, agency_id, type_id, name, email, phone, notes, start_at, end_at, status, cancelled_by, google_event_id, meet_link, calendar_error, deal_id, client_id, created_at) on public.bookings to authenticated;
