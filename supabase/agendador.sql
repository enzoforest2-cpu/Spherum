-- Agendador do Spherum (aplicado à mão no Supabase; fora de migrations/ porque os testes não têm
-- pg_cron). Chama as duas rotas do agendador a cada 15 minutos com o CRON_SECRET da Vercel.
--
-- A senha fica no cofre do Supabase. Para criar ou trocar (o mesmo valor do CRON_SECRET da Vercel):
--   select vault.create_secret('<CRON_SECRET>', 'spherum_cron_secret', 'Authorization do agendador');
--   select vault.update_secret((select id from vault.secrets where name = 'spherum_cron_secret'), '<CRON_SECRET>');
-- Ver as últimas chamadas: select * from net._http_response order by created desc limit 10;
-- Ver as execuções:        select * from cron.job_run_details order by start_time desc limit 10;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.spherum_cron_call(path text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_get(
    url := 'https://spherum.com.br' || path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'spherum_cron_secret')),
    timeout_milliseconds := 300000
  );
$$;
revoke all on function public.spherum_cron_call(text) from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname in ('spherum-agendador', 'spherum-memoria');
select cron.schedule('spherum-agendador', '*/15 * * * *', $$select public.spherum_cron_call('/api/cron/xodos')$$);
select cron.schedule('spherum-memoria', '7-59/15 * * * *', $$select public.spherum_cron_call('/api/cron/xodos/memoria')$$);
