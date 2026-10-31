-- App de celular: o Spherum instalado na tela inicial (PWA) recebe os avisos como notificação (Web
-- Push). Cada pessoa escolhe o que recebe e um horário de silêncio. O navegador só lê (RLS: os
-- próprios aparelhos e preferências); a escrita passa pelo servidor.

create table public.push_devices (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  label text check (char_length(label) <= 120),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_error text check (char_length(last_error) <= 300)
);
create index push_devices_user on public.push_devices (agency_id, user_id);

create table public.push_prefs (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  user_id uuid not null,
  -- Categorias: appr (aprovações), hot (leads), fail (falhas), chat (menções), xodo (tudo dos xodós).
  categories text[] not null default '{appr,hot,fail,chat}',
  quiet_start int check (quiet_start between 0 and 23),
  quiet_end int check (quiet_end between 0 and 23),
  updated_at timestamptz not null default now(),
  primary key (agency_id, user_id)
);

-- Aviso já entregue por push (ou descartado pelas preferências).
alter table public.notifications add column pushed_at timestamptz;
create index notifications_unpushed on public.notifications (created_at) where pushed_at is null;

alter table public.push_devices enable row level security;
alter table public.push_prefs enable row level security;
create policy push_devices_read on public.push_devices for select to authenticated using (user_id = auth.uid());
create policy push_prefs_read on public.push_prefs for select to authenticated using (user_id = auth.uid());
grant select (id, agency_id, user_id, label, created_at, last_seen_at, last_error) on public.push_devices to authenticated;
grant select on public.push_prefs to authenticated;
