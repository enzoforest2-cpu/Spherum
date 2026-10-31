-- Chamados: pedidos dos clientes com prazo de primeira resposta, responsável e histórico.
-- O prazo (em horas) por prioridade fica na agência (ticket_sla). O cliente abre pelo portal;
-- a equipe também registra o que chegou por telefone ou WhatsApp.
-- O navegador só lê (RLS); toda escrita passa pelo servidor.

alter table public.agencies add column ticket_sla jsonb not null default '{"alta": 2, "media": 8, "baixa": 24}'::jsonb;

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  client_id uuid not null,
  subject text not null check (char_length(subject) between 1 and 160),
  priority text not null default 'media' check (priority in ('alta', 'media', 'baixa')),
  status text not null default 'aberto' check (status in ('aberto', 'resolvido')),
  assignee_user uuid,
  source text not null default 'portal' check (source in ('portal', 'equipe')),
  opened_by uuid,
  -- Prazo da primeira resposta, calculado na abertura (e ao mudar a prioridade).
  due_at timestamptz not null,
  first_response_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, agency_id) references public.clients (id, agency_id) on delete cascade
);
create index tickets_agency on public.tickets (agency_id, status, created_at desc);
create trigger tickets_touch before update on public.tickets for each row execute function public.app_touch_updated_at();

create table public.ticket_messages (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  side text not null check (side in ('cliente', 'agencia')),
  author_user uuid,
  text text not null check (char_length(text) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index ticket_messages_ticket on public.ticket_messages (ticket_id, id);

alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;
create policy tickets_read on public.tickets for select to authenticated using (
  public.app_is_agency_member(agency_id) or public.app_is_client_user(client_id)
);
create policy ticket_messages_read on public.ticket_messages for select to authenticated using (
  public.app_is_agency_member(agency_id)
  or exists (select 1 from public.tickets t where t.id = ticket_id and public.app_is_client_user(t.client_id))
);
grant select on public.tickets, public.ticket_messages to authenticated;
