-- Conteúdo e Publicar: posts dos clientes num calendário, aprovação pelo portal (client_approvals)
-- e publicação no Instagram e no Facebook pela API da Meta, na hora agendada.
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

alter table public.agencies add column content_auto_publish boolean not null default false;

-- Perfis de cada cliente (página do Facebook e Instagram profissional ligado a ela).
create table public.client_social (
  client_id uuid primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  connection_id uuid not null references public.integration_connections(id) on delete cascade,
  page_id text not null check (page_id ~ '^\d{1,40}$'),
  page_name text check (char_length(page_name) <= 200),
  ig_user_id text check (ig_user_id ~ '^\d{1,40}$'),
  ig_username text check (char_length(ig_username) <= 100),
  last_error text check (char_length(last_error) <= 400),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);

create table public.content_posts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  title text not null check (char_length(title) between 1 and 120),
  caption text not null default '' check (char_length(caption) <= 2200),
  kind text not null default 'post' check (kind in ('post', 'carrossel', 'reels', 'story')),
  nets text[] not null default '{IG}' check (cardinality(nets) between 1 and 2 and nets <@ array['IG', 'FB']),
  publish_at timestamptz not null,
  -- draft rascunho · wait com o cliente · fix ajustes pedidos · appr aprovado · sched na fila para sair
  -- sozinho · publishing saindo agora · pub publicado · fail falhou
  status text not null default 'draft' check (status in ('draft', 'wait', 'fix', 'appr', 'sched', 'publishing', 'pub', 'fail')),
  version int not null default 1 check (version between 1 and 99),
  media_ids uuid[] not null default '{}' check (cardinality(media_ids) <= 10),
  approval_id uuid references public.client_approvals(id) on delete set null,
  approved_at timestamptz,
  published_at timestamptz,
  results jsonb not null default '{}'::jsonb check (pg_column_size(results) <= 8000),
  error text check (char_length(error) <= 600),
  attempts int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index content_posts_agency_date on public.content_posts (agency_id, publish_at);
create index content_posts_due on public.content_posts (publish_at) where status = 'sched';
create index content_posts_approval on public.content_posts (approval_id) where approval_id is not null;
create trigger content_posts_touch before update on public.content_posts for each row execute function public.app_touch_updated_at();

create table public.content_comments (
  id bigint generated always as identity primary key,
  post_id uuid not null references public.content_posts(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  side text not null check (side in ('agencia', 'cliente', 'sistema')),
  author_user uuid,
  text text not null check (char_length(text) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index content_comments_post on public.content_comments (post_id, id);

alter table public.client_social enable row level security;
alter table public.content_posts enable row level security;
alter table public.content_comments enable row level security;
create policy client_social_read on public.client_social for select to authenticated using (public.app_is_agency_member(agency_id));
create policy content_posts_read on public.content_posts for select to authenticated using (public.app_is_agency_member(agency_id));
create policy content_comments_read on public.content_comments for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.client_social, public.content_posts, public.content_comments to authenticated;
