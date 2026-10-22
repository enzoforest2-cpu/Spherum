-- Radar de risco e NPS.
--   nps_requests: a agência pede a nota; o portal do cliente mostra a pergunta enquanto há pedido aberto.
--   nps_responses: a nota (0 a 10) e o comentário de quem é do cliente.
--   risk_actions: "marcar como resolvido" no radar (baixa o risco por 14 dias).
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

create table public.nps_requests (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  question text not null check (char_length(question) between 10 and 300),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  answered_at timestamptz,
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index nps_requests_open on public.nps_requests (client_id) where answered_at is null;

create table public.nps_responses (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  request_id uuid references public.nps_requests(id) on delete set null,
  user_id uuid,
  score int not null check (score between 0 and 10),
  comment text check (char_length(comment) <= 2000),
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index nps_responses_client on public.nps_responses (client_id, created_at desc);

create table public.risk_actions (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  note text check (char_length(note) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index risk_actions_client on public.risk_actions (client_id, created_at desc);

alter table public.nps_requests enable row level security;
alter table public.nps_responses enable row level security;
alter table public.risk_actions enable row level security;
create policy nps_requests_read on public.nps_requests for select to authenticated using (public.app_is_agency_member(agency_id) or public.app_is_client_user(client_id));
create policy nps_responses_read on public.nps_responses for select to authenticated using (public.app_is_agency_member(agency_id));
create policy risk_actions_read on public.risk_actions for select to authenticated using (public.app_is_agency_member(agency_id));
grant select on public.nps_requests, public.nps_responses, public.risk_actions to authenticated;
