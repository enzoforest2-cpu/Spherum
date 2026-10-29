-- Cargos da agência: cada agência cria os seus (nome livre) e escolhe, por área, se o cargo não
-- vê, só vê ou vê e edita. Os cargos prontos entram como sugestão em toda agência e podem ser
-- alterados ou apagados. O dono (role = 'owner') não tem cargo: pode tudo.
-- Áreas: clientes, comercial, campanhas, projetos, financeiro, equipe, xodos, configuracoes.
-- Lido e gravado só pelo servidor.

create table public.agency_roles (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  description text not null default '' check (char_length(description) <= 200),
  perms jsonb not null default '{}'::jsonb check (jsonb_typeof(perms) = 'object' and pg_column_size(perms) <= 2000),
  -- Cargo pronto de origem (só para informação; editar não muda isto).
  preset text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agency_roles_name on public.agency_roles (agency_id, lower(btrim(name)));
alter table public.agency_roles enable row level security;

alter table public.agency_members add column if not exists role_id uuid references public.agency_roles(id) on delete set null;
alter table public.invites add column if not exists role_id uuid references public.agency_roles(id) on delete set null;

-- Os cargos prontos. Mudar aqui só vale para agências novas.
create or replace function public.app_seed_agency_roles(p_agency uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.agency_roles (agency_id, name, description, perms, preset, position) values
    (p_agency, 'Administrador', 'Cuida de tudo, inclusive equipe e configurações.',
      '{"clientes":"editar","comercial":"editar","campanhas":"editar","projetos":"editar","financeiro":"editar","equipe":"editar","xodos":"editar","configuracoes":"editar"}', 'administrador', 1),
    (p_agency, 'Gestor de tráfego', 'Campanhas, relatórios e o dia a dia dos clientes.',
      '{"clientes":"editar","comercial":"ver","campanhas":"editar","projetos":"editar","financeiro":"nenhum","equipe":"ver","xodos":"editar","configuracoes":"ver"}', 'gestor', 2),
    (p_agency, 'Atendimento', 'Relacionamento com os clientes, comercial e projetos.',
      '{"clientes":"editar","comercial":"editar","campanhas":"ver","projetos":"editar","financeiro":"nenhum","equipe":"ver","xodos":"editar","configuracoes":"nenhum"}', 'atendimento', 3),
    (p_agency, 'Financeiro', 'Cobranças, notas, contratos e resultados da agência.',
      '{"clientes":"ver","comercial":"ver","campanhas":"nenhum","projetos":"ver","financeiro":"editar","equipe":"ver","xodos":"ver","configuracoes":"nenhum"}', 'financeiro', 4),
    (p_agency, 'Leitor', 'Só acompanha: vê, mas não altera nada.',
      '{"clientes":"ver","comercial":"ver","campanhas":"ver","projetos":"ver","financeiro":"nenhum","equipe":"ver","xodos":"ver","configuracoes":"nenhum"}', 'leitor', 5)
  on conflict do nothing;
$$;
revoke all on function public.app_seed_agency_roles(uuid) from public, anon, authenticated;

create or replace function public.app_agency_roles_seed_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.app_seed_agency_roles(new.id);
  return new;
end;
$$;
revoke all on function public.app_agency_roles_seed_trigger() from public, anon, authenticated;
create trigger agencies_seed_roles after insert on public.agencies for each row execute function public.app_agency_roles_seed_trigger();

-- Agências que já existem: recebem os cargos prontos, e cada pessoa vai para o cargo do papel antigo.
select public.app_seed_agency_roles(id) from public.agencies;
update public.agency_members m set role_id = r.id
  from public.agency_roles r
 where r.agency_id = m.agency_id and m.role <> 'owner' and m.role_id is null
   and r.preset = case m.role when 'admin' then 'administrador' when 'member' then 'gestor' when 'financeiro' then 'financeiro' else 'leitor' end;
update public.invites i set role_id = r.id
  from public.agency_roles r
 where r.agency_id = i.agency_id and i.kind = 'equipe' and i.role_id is null and i.accepted_at is null
   and r.preset = case i.role when 'admin' then 'administrador' when 'member' then 'gestor' when 'financeiro' then 'financeiro' else 'leitor' end;
