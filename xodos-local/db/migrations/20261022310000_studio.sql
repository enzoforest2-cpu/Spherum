-- Estúdio: criativos gerados por IA com a conta da própria agência (fal.ai ou Replicate), usando o
-- kit da marca de cada cliente. As imagens ficam em Documentos (categoria Criativos); vídeo roda em
-- fila e o cron busca o resultado. O navegador só lê (RLS); a geração passa pelo servidor.

-- Kit da marca: cores, fonte, produto, chamada, preço, botão e o estilo das cenas.
create table public.client_brand_kits (
  client_id uuid primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  color1 text check (color1 ~ '^#[0-9A-Fa-f]{6}$'),
  color2 text check (color2 ~ '^#[0-9A-Fa-f]{6}$'),
  font text check (char_length(font) <= 60),
  product text check (char_length(product) <= 120),
  headline text check (char_length(headline) <= 120),
  price text check (char_length(price) <= 40),
  cta text check (char_length(cta) <= 40),
  style text check (char_length(style) <= 500),
  logo_document_id uuid references public.documents(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);

-- Configuração do Estúdio na agência: conexão (fal ou replicate) e os modelos de imagem e vídeo.
alter table public.agencies add column studio_config jsonb not null default '{}'::jsonb
  check (jsonb_typeof(studio_config) = 'object' and pg_column_size(studio_config) <= 4000);

create table public.studio_messages (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  role text not null check (role in ('me', 'ai', 'sys')),
  text text not null check (char_length(text) between 1 and 2000),
  -- Imagens geradas (documentos) e o formato.
  document_ids uuid[] not null default '{}',
  format text check (format in ('feed', 'story', 'video')),
  author_user uuid,
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index studio_messages_client on public.studio_messages (client_id, id);

-- Vídeos na fila do provedor.
create table public.studio_jobs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  message_id bigint references public.studio_messages(id) on delete set null,
  provider text not null,
  model text not null,
  request_id text not null,
  status text not null default 'fila' check (status in ('fila', 'pronto', 'falhou')),
  document_id uuid references public.documents(id) on delete set null,
  error text check (char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index studio_jobs_open on public.studio_jobs (created_at) where status = 'fila';
create trigger studio_jobs_touch before update on public.studio_jobs for each row execute function public.app_touch_updated_at();

alter table public.client_brand_kits enable row level security;
alter table public.studio_messages enable row level security;
alter table public.studio_jobs enable row level security;
create policy client_brand_kits_read on public.client_brand_kits for select to authenticated using (public.app_is_agency_member(agency_id));
create policy studio_messages_read on public.studio_messages for select to authenticated using (public.app_is_agency_member(agency_id));
create policy studio_jobs_read on public.studio_jobs for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.client_brand_kits, public.studio_messages, public.studio_jobs to authenticated;
