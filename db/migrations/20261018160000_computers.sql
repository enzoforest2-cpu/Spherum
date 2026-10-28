-- Computador na nuvem dos Xodós: navegador, arquivos e terminal numa máquina por agência,
-- com a pessoa podendo assumir o controle (modelos do Rakazo, OpenDots e OpenMausBot).
--
-- A máquina só executa: o motor continua no servidor do Spherum e nenhum token de integração,
-- chave de IA ou segredo entra nela. Todo estado fica aqui, com troca atômica e fence (a Vercel
-- não guarda memória entre chamadas). Depende das migrações dos Xodós, canais e memória.

-- Chaves de máquina (E2B, Daytona) no mesmo cofre das chaves de modelo.
alter table public.ai_credentials add column kind text not null default 'model' check (kind in ('model', 'sandbox'));

-- Uma máquina por agência, criada na primeira vez que alguém precisa dela.
create table public.computers (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null unique references public.agencies(id) on delete cascade,
  provider text not null check (provider in ('e2b', 'daytona', 'fake')),
  -- Chave da própria agência (BYOK); nula: a chave do Spherum, quando houver o add-on.
  credential_id uuid references public.ai_credentials(id) on delete set null,
  -- Id da máquina no provedor (nunca sai do servidor).
  provider_ref text,
  -- Versão do preparo da máquina (pacotes, usuário sem sudo, rede): muda, prepara de novo.
  runtime_version text,
  state text not null default 'none'
    check (state in ('none', 'provisioning', 'running', 'pausing', 'paused', 'resuming', 'destroying', 'destroyed', 'error')),
  -- Quantas máquinas já foram criadas (a cada recriação, +1) e o fence de cada transição.
  generation integer not null default 0,
  fence bigint not null default 0,
  transition_at timestamptz,
  last_activity_at timestamptz,
  -- Quando o provedor pausa sozinho por ociosidade (última atividade + idle_ms).
  expires_at timestamptz,
  session_started_at timestamptz,
  idle_ms integer not null default 600000 check (idle_ms between 300000 and 3600000),
  daily_hours_cap numeric(5, 2) not null default 4 check (daily_hours_cap between 0.25 and 24),
  egress_mode text not null default 'aberto' check (egress_mode in ('aberto', 'restrito')),
  -- Tela: uma execução por vez (lease renovado a cada ação).
  screen_run_id uuid,
  screen_fence bigint not null default 0,
  screen_expires_at timestamptz,
  -- Pessoa no controle: tudo do xodó no computador para enquanto ela estiver lá.
  control_user_id uuid,
  control_lease_id uuid,
  control_fence bigint not null default 0,
  control_token_hash text,
  control_started_at timestamptz,
  control_expires_at timestamptz,
  control_run_id uuid,
  last_frame_path text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Tempo ligado, para medir uso e custo (em dólar e reais, pela mesma PTAX do gasto com IA).
create table public.computer_sessions (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  computer_id uuid not null references public.computers(id) on delete cascade,
  provider text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  seconds integer,
  cost_usd numeric(12, 6),
  usd_brl numeric(12, 6),
  cost_brl numeric(12, 4)
);
create index computer_sessions_agency on public.computer_sessions (agency_id, started_at desc);
create unique index computer_sessions_open on public.computer_sessions (computer_id) where ended_at is null;

-- Linha do tempo: ciclo de vida, controle, uploads e downloads, recusas do piso e cada ação.
create table public.computer_events (
  id bigint generated always as identity primary key,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  computer_id uuid references public.computers(id) on delete cascade,
  xodo_id uuid,
  run_id uuid,
  action_id uuid,
  user_id uuid,
  kind text not null check (char_length(kind) between 1 and 40),
  status text not null default 'succeeded' check (status in ('pending', 'succeeded', 'failed', 'denied')),
  -- Resumo já sem dados sensíveis, sem conteúdo de arquivo e sem texto digitado.
  summary text check (char_length(summary) <= 200),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index computer_events_agency on public.computer_events (agency_id, id desc);

-- Fotos da página (até 80 elementos com ref): o clique usa o rótulo guardado aqui, nunca o do modelo.
create table public.computer_snapshots (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  computer_id uuid not null references public.computers(id) on delete cascade,
  run_id uuid,
  url text not null,
  title text,
  elements jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index computer_snapshots_created on public.computer_snapshots (created_at);

-- Categoria de aprovação por site, ajustável pela agência (ex.: a ferramenta interna dela).
create table public.computer_site_rules (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies(id) on delete cascade,
  pattern text not null check (char_length(pattern) between 1 and 200),
  category text not null check (category in ('leitura', 'alteracao', 'envio', 'exclusao', 'pagamento', 'campanha', 'cliente', 'so_voce')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (agency_id, pattern)
);

-- Por xodó: liga o computador e cada parte dele (tudo desligado por padrão, como no OpenDots).
alter table public.xodos
  add column computer_mode text not null default 'off' check (computer_mode in ('off', 'cloud', 'local')),
  add column computer_browser boolean not null default false,
  add column computer_files boolean not null default false,
  add column computer_terminal boolean not null default false;

-- Execução esperando a pessoa no computador; nota de retomada; contaminação por conteúdo de fora.
alter table public.xodo_runs drop constraint if exists xodo_runs_status_check;
alter table public.xodo_runs add constraint xodo_runs_status_check
  check (status in ('running', 'waiting_approval', 'waiting_takeover', 'completed', 'failed', 'paused_budget', 'refused'));
alter table public.xodo_runs add column resume_note text;
alter table public.xodo_runs add column tainted boolean not null default false;
-- Execução longa em fatias (a função da Vercel tem tempo máximo): quando a fatia acabou e a
-- próxima ainda não começou. O cron continua as fatias que ficaram para trás.
alter table public.xodo_runs add column slice_due_at timestamptz;
create index xodo_runs_slices on public.xodo_runs (slice_due_at) where slice_due_at is not null;

-- Ação de tela aprovada só roda se a página ainda for a mesma (url, rótulo).
alter table public.xodo_actions add column precondition jsonb;

-- Arquivos que o xodó anexa na conversa (caminho no Storage; a URL assinada é gerada na leitura).
alter table public.xodo_messages add column attachments jsonb not null default '[]'::jsonb;

-- "Aprovar sempre" de uma ação de tela vale para o site (ex.: navegador_clicar@business.facebook.com).
alter table public.approval_rules drop constraint if exists approval_rules_match_kind_check;
alter table public.approval_rules add constraint approval_rules_match_kind_check check (match_kind in ('tool', 'category', 'site'));

-- ---------------------------------------------------------------------------
-- Acesso: só leitura para quem é da agência; toda escrita passa pelo servidor
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['computers', 'computer_sessions', 'computer_events', 'computer_snapshots', 'computer_site_rules'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  foreach t in array array['computers', 'computer_sessions', 'computer_events', 'computer_site_rules'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.app_is_agency_member(agency_id))',
      t || '_member_read', t);
  end loop;
end $$;

grant select on public.computer_sessions, public.computer_events, public.computer_site_rules to authenticated;
-- Da máquina, sem o id no provedor nem o token de controle.
grant select (id, agency_id, provider, credential_id, runtime_version, state, generation, last_activity_at, expires_at,
              session_started_at, idle_ms, daily_hours_cap, egress_mode, screen_run_id, screen_expires_at, control_user_id,
              control_started_at, control_expires_at, control_run_id, error, created_at, updated_at)
  on public.computers to authenticated;

-- Bucket privado dos arquivos do computador (anexos, uploads e downloads por URL assinada).
-- Só existe no Supabase; fora dele (testes) o bloco não faz nada.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('computer-files', 'computer-files', false)
      on conflict (id) do nothing;
  end if;
end $$;
