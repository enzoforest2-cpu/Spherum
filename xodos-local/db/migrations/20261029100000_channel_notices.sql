-- Avisos do sino repassados ao Telegram ou WhatsApp de quem é avisado (ver server/channels.ts).
-- Cada aviso sai uma vez só; os que já existiam antes desta migração não são repassados.
alter table public.notifications add column channel_sent_at timestamptz;
update public.notifications set channel_sent_at = created_at;
create index notifications_unsent_channel on public.notifications (agency_id, created_at) where channel_sent_at is null;
