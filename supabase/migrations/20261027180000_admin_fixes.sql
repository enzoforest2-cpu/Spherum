-- Correções da revisão do admin.

-- Agência suspensa: as regras de acesso do banco também cortam a equipe e os clientes dela, não só
-- as rotas do servidor. Sem isso, quem tem login ainda leria os dados pela API do Supabase.
create or replace function public.app_is_agency_member(p_agency uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.agency_members m join public.agencies a on a.id = m.agency_id
    where m.agency_id = p_agency and m.user_id = auth.uid() and a.suspended_at is null
  );
$$;

create or replace function public.app_is_client_user(p_client uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.client_portal_users u
      join public.clients c on c.id = u.client_id
      join public.agencies a on a.id = c.agency_id
    where u.client_id = p_client and u.user_id = auth.uid() and a.suspended_at is null
  );
$$;

-- Comunicados: a entrega fica registrada por agência. O envio é marcado como "sending" ao começar e
-- só vira "sent" quando todos os e-mails saíram; se for interrompido, o cron retoma de onde parou.
alter table public.announcements drop constraint if exists announcements_status_check;
alter table public.announcements add constraint announcements_status_check check (status in ('draft', 'scheduled', 'sending', 'sent'));
create index if not exists announcements_sending on public.announcements (sent_at) where status = 'sending';

create table public.announcement_deliveries (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  emailed_at timestamptz,
  email_ok boolean,
  primary key (announcement_id, agency_id)
);
create index announcement_deliveries_pending on public.announcement_deliveries (announcement_id) where emailed_at is null;
alter table public.announcement_deliveries enable row level security;
