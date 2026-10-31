-- Sincronização de anúncios: quando tentar de novo. Uma conta que falhou espera (1 h; 24 h se o login foi
-- recusado) em vez de voltar a cada ciclo do cron e tomar a vez das contas saudáveis.
alter table public.client_ad_accounts add column if not exists next_sync_at timestamptz;
update public.client_ad_accounts set next_sync_at = last_synced_at + interval '6 hours' where next_sync_at is null and last_synced_at is not null;
create index if not exists client_ad_accounts_next_sync on public.client_ad_accounts (next_sync_at) where connection_id is not null;
