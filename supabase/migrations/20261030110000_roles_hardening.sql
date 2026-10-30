-- Cargos: o cargo de uma pessoa ou convite só pode ser da mesma agência, e um cargo em uso não
-- some (o servidor move as pessoas antes de apagar). E as leituras diretas pelo banco (API do
-- Supabase com o login da pessoa) seguem o cargo: quem tem "nenhum" numa área não lê as tabelas
-- dela, como já acontece nas rotas do servidor.

create unique index if not exists agency_roles_agency_id_id on public.agency_roles (agency_id, id);

alter table public.agency_members drop constraint if exists agency_members_role_id_fkey;
alter table public.agency_members add constraint agency_members_role_fk
  foreign key (agency_id, role_id) references public.agency_roles (agency_id, id);
alter table public.invites drop constraint if exists invites_role_id_fkey;
alter table public.invites add constraint invites_role_fk
  foreign key (agency_id, role_id) references public.agency_roles (agency_id, id);

-- Pode ver a área? Dono sim; com cargo, "ver" ou "editar"; sem cargo (dado antigo), o papel antigo.
create or replace function public.app_can_read(p_agency uuid, p_area text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.agency_members m
      join public.agencies a on a.id = m.agency_id
      left join public.agency_roles r on r.id = m.role_id and r.agency_id = m.agency_id
     where m.agency_id = p_agency and m.user_id = auth.uid() and a.suspended_at is null
       and (
         m.role = 'owner'
         or (r.id is not null and r.perms ->> p_area in ('ver', 'editar'))
         or (r.id is null and (
              m.role in ('admin', 'member')
              or (m.role = 'financeiro' and p_area in ('clientes', 'comercial', 'projetos', 'financeiro', 'equipe', 'xodos'))
              or (m.role = 'viewer' and p_area in ('clientes', 'comercial', 'campanhas', 'projetos', 'equipe', 'xodos'))))
       )
  );
$$;
revoke all on function public.app_can_read(uuid, text) from public, anon;
grant execute on function public.app_can_read(uuid, text) to authenticated;

-- Cada tabela lida pelo login da pessoa passa a pedir a área dela.
do $$
declare spec text; p text[]; pol record; q text;
begin
  foreach spec in array array[
    'clients|clientes', 'client_contacts|clientes', 'client_messages|clientes', 'client_requests|clientes', 'client_updates|clientes',
    'client_portal_users|clientes', 'documents|clientes', 'tickets|clientes', 'ticket_messages|clientes', 'risk_actions|clientes',
    'nps_requests|clientes', 'nps_responses|clientes',
    'deals|comercial', 'proposals|comercial', 'forms|comercial', 'form_submissions|comercial', 'booking_types|comercial',
    'bookings|comercial', 'prospect_leads|comercial', 'prospect_messages|comercial', 'prospect_optouts|comercial',
    'client_ad_accounts|campanhas', 'metrics_daily|campanhas', 'analytics_daily|campanhas', 'reports|campanhas',
    'client_sales|campanhas', 'aivis_checks|campanhas', 'aivis_clients|campanhas', 'aivis_queries|campanhas',
    'projects|projetos', 'project_tasks|projetos', 'time_entries|projetos', 'content_posts|projetos', 'content_comments|projetos',
    'studio_jobs|projetos', 'studio_messages|projetos', 'client_brand_kits|projetos', 'client_social|projetos',
    'client_approvals|projetos', 'automations|projetos', 'automation_runs|projetos', 'meetings|projetos', 'meeting_steps|projetos',
    'finance_entries|financeiro', 'fiscal_notes|financeiro', 'invoices|financeiro', 'invoice_recurrences|financeiro',
    'invoice_reminders|financeiro', 'client_contracts|financeiro',
    'agency_members|equipe', 'academy_assignments|equipe', 'academy_items|equipe', 'academy_progress|equipe', 'kudos|equipe',
    'team_channels|equipe', 'team_messages|equipe',
    'xodos|xodos', 'xodo_actions|xodos', 'xodo_apps|xodos', 'xodo_budget_days|xodos', 'xodo_channels|xodos', 'xodo_clients|xodos',
    'xodo_conversations|xodos', 'xodo_memories|xodos', 'xodo_memory_captures|xodos', 'xodo_memory_changes|xodos',
    'xodo_memory_items|xodos', 'xodo_memory_revisions|xodos', 'xodo_memory_topics|xodos', 'xodo_messages|xodos', 'xodo_models|xodos',
    'xodo_routines|xodos', 'xodo_runs|xodos', 'xodo_tools|xodos', 'approval_rules|xodos', 'ai_credentials|xodos', 'ai_usage|xodos',
    'computers|xodos', 'computer_events|xodos', 'computer_sessions|xodos', 'computer_site_rules|xodos',
    'integration_connections|configuracoes', 'oauth_states|configuracoes', 'event_triggers|configuracoes', 'event_deliveries|configuracoes'
  ] loop
    p := string_to_array(spec, '|');
    for pol in select policyname, qual from pg_policies
                where schemaname = 'public' and tablename = p[1] and cmd = 'SELECT' and qual like '%app_is_agency_member(%' loop
      q := regexp_replace(pol.qual, 'app_is_agency_member\(([a-z_.]+)\)', 'app_can_read(\1, ''' || p[2] || ''')', 'g');
      execute format('alter policy %I on public.%I using (%s)', pol.policyname, p[1], q);
    end loop;
  end loop;
end $$;

-- Os colegas de equipe: a pessoa sempre vê o próprio perfil; os outros, só quem vê a área Equipe.
alter policy profiles_read on public.profiles using (id = (select auth.uid()) or exists (
  select 1 from public.agency_members mine join public.agency_members theirs on theirs.agency_id = mine.agency_id
   where mine.user_id = (select auth.uid()) and theirs.user_id = profiles.id and public.app_can_read(mine.agency_id, 'equipe')));
