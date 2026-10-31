-- Colaboração entre a agência e o cliente, no portal do cliente:
--   client_updates    "Feito pela agência": o que a equipe e os xodós fizeram, em português claro.
--                     O que um xodó faz numa campanha entra como rascunho; a equipe publica (ou a
--                     agência liga a publicação automática em portal_settings).
--   client_requests   Pendências: o que a agência precisa do cliente (acesso, material, resposta).
--   client_approvals  Aprovações: criativos, páginas e textos que o cliente aprova ou pede ajuste.
--   client_messages   Conversa entre a agência e o cliente.
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

alter table public.agencies add column portal_settings jsonb not null default '{}'::jsonb;

create table public.client_updates (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  kind text not null default 'equipe' check (kind in ('otimizacao', 'alerta', 'relatorio', 'equipe')),
  title text not null check (char_length(title) between 1 and 200),
  why text check (char_length(why) <= 600),
  impact text check (char_length(impact) <= 120),
  source text not null default 'equipe' check (source in ('equipe', 'xodo', 'sistema')),
  xodo_id uuid references public.xodos(id) on delete set null,
  -- Ação do xodó que gerou a atualização (sem FK: as ações somem com a execução).
  action_id uuid unique,
  report_id uuid unique references public.reports(id) on delete cascade,
  status text not null default 'rascunho' check (status in ('rascunho', 'publicado', 'descartado')),
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index client_updates_client on public.client_updates (client_id, created_at desc);
create index client_updates_drafts on public.client_updates (agency_id) where status = 'rascunho';
create trigger client_updates_touch before update on public.client_updates for each row execute function public.app_touch_updated_at();

create table public.client_requests (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  details text check (char_length(details) <= 2000),
  -- passos: o cliente faz algo e marca "já fiz"; texto: responde por escrito; arquivo: envia um arquivo.
  kind text not null default 'texto' check (kind in ('passos', 'texto', 'arquivo')),
  steps text[] not null default '{}',
  due_date date,
  status text not null default 'aberto' check (status in ('aberto', 'feito', 'cancelado')),
  response text check (char_length(response) <= 4000),
  document_id uuid references public.documents(id) on delete set null,
  done_by uuid,
  done_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index client_requests_client on public.client_requests (client_id, created_at desc);
create trigger client_requests_touch before update on public.client_requests for each row execute function public.app_touch_updated_at();

create table public.client_approvals (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  details text check (char_length(details) <= 2000),
  document_id uuid references public.documents(id) on delete set null,
  link text check (char_length(link) <= 1000 and link ~ '^https://'),
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'alteracoes', 'cancelado')),
  comment text check (char_length(comment) <= 2000),
  decided_by uuid,
  decided_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index client_approvals_client on public.client_approvals (client_id, created_at desc);
create index client_approvals_open on public.client_approvals (agency_id) where status = 'pendente';
create trigger client_approvals_touch before update on public.client_approvals for each row execute function public.app_touch_updated_at();

create table public.client_messages (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  side text not null check (side in ('agencia', 'cliente')),
  author_user uuid,
  text text not null check (char_length(text) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index client_messages_client on public.client_messages (client_id, id desc);

-- Até onde cada lado leu a conversa (para o "não lidas").
create table public.client_message_reads (
  client_id uuid not null references public.clients(id) on delete cascade,
  side text not null check (side in ('agencia', 'cliente')),
  last_read_id bigint not null default 0,
  primary key (client_id, side)
);

alter table public.client_updates enable row level security;
alter table public.client_requests enable row level security;
alter table public.client_approvals enable row level security;
alter table public.client_messages enable row level security;
alter table public.client_message_reads enable row level security;

create policy client_updates_read on public.client_updates for select to authenticated using (
  public.app_is_agency_member(agency_id) or (status = 'publicado' and public.app_is_client_user(client_id))
);
create policy client_requests_read on public.client_requests for select to authenticated using (
  public.app_is_agency_member(agency_id) or (status <> 'cancelado' and public.app_is_client_user(client_id))
);
create policy client_approvals_read on public.client_approvals for select to authenticated using (
  public.app_is_agency_member(agency_id) or (status <> 'cancelado' and public.app_is_client_user(client_id))
);
create policy client_messages_read on public.client_messages for select to authenticated using (
  public.app_is_agency_member(agency_id) or public.app_is_client_user(client_id)
);
grant select (id, agency_id, client_id, kind, title, why, impact, source, xodo_id, status, published_at, created_at) on public.client_updates to authenticated;
grant select on public.client_requests, public.client_approvals, public.client_messages to authenticated;
