-- Documentos da agência e dos clientes (contratos, briefings, criativos, relatórios em PDF...).
-- O arquivo fica no bucket privado "documents" do Storage; aqui ficam os dados e quem vê.
-- O envio é em dois passos: o servidor registra o documento e devolve uma URL assinada de
-- upload; depois de enviado, o servidor confirma e o documento aparece. Downloads também são
-- por URL assinada curta, gerada pelo servidor depois de checar o acesso.

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  -- Nulo: documento interno da agência, sem cliente.
  client_id uuid,
  name text not null check (char_length(name) between 1 and 200),
  category text not null default 'Outros' check (category in ('Contratos', 'Briefings', 'Criativos', 'Relatórios', 'Financeiro', 'Outros')),
  mime text check (char_length(mime) <= 120),
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  storage_path text not null unique check (char_length(storage_path) <= 400),
  -- Visível no portal do cliente.
  shared boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index documents_agency on public.documents (agency_id, created_at desc);
create index documents_client on public.documents (client_id, created_at desc) where client_id is not null;
create trigger documents_touch before update on public.documents for each row execute function public.app_touch_updated_at();

alter table public.documents enable row level security;
create policy documents_read on public.documents for select to authenticated using (
  status = 'ready' and (public.app_is_agency_member(agency_id) or (shared and client_id is not null and public.app_is_client_user(client_id)))
);
grant select (id, agency_id, client_id, name, category, mime, size_bytes, shared, status, uploaded_by, created_at, updated_at)
  on public.documents to authenticated;

-- Bucket privado (até 50 MB por arquivo). Só existe no Supabase; nos testes o bloco não faz nada.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit) values ('documents', 'documents', false, 52428800)
      on conflict (id) do nothing;
  end if;
end $$;
