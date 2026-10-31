-- Busca por IA: perguntas que um cliente do cliente faria a um assistente de IA, checadas nos modelos
-- que a agência tem chave (ChatGPT, Gemini, Claude…): a marca aparece? Em que lugar? E os concorrentes?
-- O navegador só lê (RLS); as checagens rodam no servidor, com custo registrado em ai_usage.

alter table public.ai_usage drop constraint if exists ai_usage_purpose_check;
alter table public.ai_usage add constraint ai_usage_purpose_check check (purpose in ('execucao', 'captura', 'arrumacao', 'busca_ia'));

create table public.aivis_clients (
  client_id uuid primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  -- Outros nomes da marca e concorrentes (para medir as menções).
  aliases text[] not null default '{}' check (cardinality(aliases) <= 10),
  competitors text[] not null default '{}' check (cardinality(competitors) <= 10),
  published boolean not null default false,
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);

create table public.aivis_queries (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  question text not null check (char_length(question) between 5 and 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index aivis_queries_client on public.aivis_queries (client_id);

create table public.aivis_checks (
  id bigint generated always as identity primary key,
  query_id uuid not null references public.aivis_queries(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  engine text not null check (char_length(engine) <= 40),
  model text check (char_length(model) <= 120),
  -- Posição na lista de recomendações (1 = primeiro); nula se citado fora de lista ou não citado.
  position int,
  mentioned boolean not null,
  competitors text[] not null default '{}',
  answer text check (char_length(answer) <= 6000),
  error text check (char_length(error) <= 500),
  checked_at timestamptz not null default now()
);
create index aivis_checks_query on public.aivis_checks (query_id, engine, checked_at desc);

alter table public.aivis_clients enable row level security;
alter table public.aivis_queries enable row level security;
alter table public.aivis_checks enable row level security;
create policy aivis_clients_read on public.aivis_clients for select to authenticated using (public.app_is_agency_member(agency_id) or (published and public.app_is_client_user(client_id)));
create policy aivis_queries_read on public.aivis_queries for select to authenticated using (public.app_is_agency_member(agency_id));
create policy aivis_checks_read on public.aivis_checks for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.aivis_clients, public.aivis_queries, public.aivis_checks to authenticated;
