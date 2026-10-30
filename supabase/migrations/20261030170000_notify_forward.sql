-- Avisos do sino também no Telegram e no WhatsApp de quem ligou o celular. Cada aviso é repassado
-- uma vez (forwarded_at) e cada pessoa pode desligar em "App de celular" (push_prefs.channels).
alter table public.notifications add column if not exists forwarded_at timestamptz;
create index if not exists notifications_to_forward on public.notifications (created_at) where forwarded_at is null;
alter table public.push_prefs add column if not exists channels boolean not null default true;
