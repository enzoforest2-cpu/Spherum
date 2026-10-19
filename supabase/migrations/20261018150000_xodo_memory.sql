-- Memória dos Xodós em notas (modelo do OpenMausBot).
--
-- Substitui o texto único de xodo_memories. Cada nota é uma linha com número (#n): o núcleo
-- (sem tópico) entra em toda conversa; as notas de tópico e de cliente entram quando a conversa
-- pede (recall) ou quando o xodó busca. Toda mudança fica no diário e pode ser desfeita por lote.
-- Depende das migrações dos Xodós e dos canais.

-- Sem acento e em minúsculas, para a busca casar "relatório" com "relatorio".
create or replace function public.xodo_fold(text) returns text language sql immutable parallel safe
  as $$ select translate(lower($1), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn') $$;

-- Identidade de uma nota: o mesmo fato escrito de jeitos levemente diferentes não duplica.
-- Igual a factIdentity em src/lib/xodos/memory/entries.ts (um teste confere os dois).
create or replace function public.xodo_fact_identity(text) returns text language sql immutable parallel safe
  as $$ select regexp_replace(regexp_replace(regexp_replace(public.xodo_fold(btrim(normalize($1, NFC))),
            '^([-*•]|[0-9]+[.)])\s+', ''), '\s+', ' ', 'g'), '[.!;]+$', '') $$;

alter table public.xodos
  add column memory_enabled boolean not null default true,
  add column memory_capture boolean not null default true,
  -- Conversas por Slack, WhatsApp e Telegram ficam fora da captura, a não ser que a equipe ligue.
  add column memory_capture_channels boolean not null default false,
  add column memory_tidy boolean not null default true,
  add column memory_core_chars integer not null default 8000 check (memory_core_chars between 2000 and 16000),
  add column memory_tidied_on date,
  add column memory_topic_cursor text,
  -- Trava da arrumação (uma por vez por xodó).
  add column memory_upkeep_until timestamptz;

alter table public.ai_usage add column purpose text not null default 'execucao'
  check (purpose in ('execucao', 'captura', 'arrumacao'));

create table public.xodo_memory_topics (
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$' and slug not in ('nucleo', 'arquivo', 'memoria')),
  title text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 12),
  updated_at timestamptz not null default now(),
  primary key (xodo_id, slug)
);

create table public.xodo_memory_items (
  id uuid primary key default gen_random_uuid(),
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  -- "#n" no prompt, nas ferramentas e na tela.
  n integer not null,
  -- Nulo: núcleo (entra em toda conversa).
  topic text,
  client_id uuid references public.clients(id) on delete cascade,
  kind text not null default 'fato' check (kind in ('preferencia', 'fato', 'decisao', 'resultado')),
  content text not null check (char_length(content) between 1 and 1000),
  identity text not null,
  -- Título e apelidos do tópico e nome do cliente, para a busca.
  search_extra text not null default '',
  search tsvector generated always as (
    to_tsvector('portuguese', public.xodo_fold(coalesce(topic, '') || ' ' || content || ' ' || search_extra))) stored,
  source text not null check (source in ('xodo', 'captura', 'equipe', 'arrumacao', 'importacao')),
  -- proposto: captura num xodó que sempre pergunta, esperando a equipe aceitar.
  status text not null default 'ativo'
    check (status in ('ativo', 'proposto', 'substituido', 'expirado', 'arquivado', 'apagado')),
  pinned boolean not null default false,
  valid_until date,
  superseded_by uuid references public.xodo_memory_items(id) on delete set null,
  confidence numeric(3, 2),
  -- A arrumação já julgou que esta nota fica no núcleo.
  kept_in_core boolean not null default false,
  run_id uuid references public.xodo_runs(id) on delete set null,
  created_by uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (xodo_id, n),
  foreign key (xodo_id, topic) references public.xodo_memory_topics(xodo_id, slug) on update cascade
);
create unique index xodo_memory_items_identity on public.xodo_memory_items
  (xodo_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'), coalesce(topic, ''), identity)
  where status in ('ativo', 'proposto');
create index xodo_memory_items_live on public.xodo_memory_items (xodo_id, topic, updated_at desc) where status = 'ativo';
create index xodo_memory_items_search on public.xodo_memory_items using gin (search);
create trigger xodo_memory_items_client_agency before insert or update of client_id on public.xodo_memory_items
  for each row execute function public.app_check_client_agency();

-- Diário: uma linha por mudança; uma ação (do xodó, da captura, da equipe) é um lote que se desfaz junto.
create table public.xodo_memory_changes (
  id bigint generated always as identity primary key,
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  batch uuid not null,
  item_id uuid references public.xodo_memory_items(id) on delete set null,
  topic text,
  op text not null check (op in ('criar', 'editar', 'substituir', 'apagar', 'expirar', 'arquivar', 'mover', 'fixar',
                                 'desfazer', 'importar', 'topico', 'expurgar', 'aceitar')),
  actor text not null check (actor in ('xodo', 'captura', 'equipe', 'arrumacao', 'sistema')),
  actor_user uuid,
  run_id uuid references public.xodo_runs(id) on delete set null,
  -- Foto da nota antes e depois (já sem dados sensíveis).
  before jsonb,
  after jsonb,
  reason text check (char_length(reason) <= 200),
  -- Lote que este desfez.
  reverts uuid,
  created_at timestamptz not null default now()
);
create index xodo_memory_changes_xodo on public.xodo_memory_changes (xodo_id, id desc);
create index xodo_memory_changes_batch on public.xodo_memory_changes (batch);
create index xodo_memory_changes_item on public.xodo_memory_changes (item_id, id desc) where item_id is not null;
create index xodo_memory_changes_run on public.xodo_memory_changes (run_id) where run_id is not null;

-- Fila da captura: uma janela de conversa por vez, por xodó e conversa.
create table public.xodo_memory_captures (
  id uuid primary key default gen_random_uuid(),
  xodo_id uuid not null references public.xodos(id) on delete cascade,
  agency_id uuid not null references public.agencies(id) on delete cascade,
  -- Nulo: conversa do app.
  conversation_id uuid references public.xodo_conversations(id) on delete cascade,
  after_message_id bigint not null,
  until_message_id bigint not null,
  last_run_id uuid references public.xodo_runs(id) on delete set null,
  turns integer not null default 1,
  status text not null default 'pendente' check (status in ('pendente', 'rodando', 'feito', 'pulado', 'falhou')),
  due_at timestamptz not null,
  locked_until timestamptz,
  attempts integer not null default 0,
  -- {propostos, gravados, descartados: [{texto, motivo}]}
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index xodo_memory_captures_pending on public.xodo_memory_captures
  (xodo_id, coalesce(conversation_id, '00000000-0000-0000-0000-000000000000')) where status = 'pendente';
create index xodo_memory_captures_due on public.xodo_memory_captures (due_at) where status in ('pendente', 'rodando');

-- ---------------------------------------------------------------------------
-- O texto antigo vira notas do núcleo (uma por linha; linhas longas em pedaços)
-- ---------------------------------------------------------------------------

with lines as (
  select m.xodo_id, m.agency_id, l.ord, btrim(l.line) as line
    from public.xodo_memories m, regexp_split_to_table(m.content, E'\n') with ordinality as l(line, ord)
   where btrim(l.line) <> ''
), pieces as (
  select xodo_id, agency_id, ord, g.i,
         btrim(substr(regexp_replace(line, '^([-*•]|[0-9]+[.)])\s+', ''), (g.i - 1) * 1000 + 1, 1000)) as piece
    from lines, generate_series(1, greatest(1, (char_length(line) + 999) / 1000)) as g(i)
), unique_pieces as (
  select distinct on (xodo_id, public.xodo_fact_identity(piece)) xodo_id, agency_id, ord, i, piece
    from pieces where piece <> ''
   order by xodo_id, public.xodo_fact_identity(piece), ord, i
)
insert into public.xodo_memory_items (xodo_id, agency_id, n, kind, content, identity, source)
select xodo_id, agency_id, row_number() over (partition by xodo_id order by ord, i), 'fato', piece,
       public.xodo_fact_identity(piece), 'importacao'
  from unique_pieces;

with batches as (select xodo_id, gen_random_uuid() as batch from (select distinct xodo_id from public.xodo_memory_items) x)
insert into public.xodo_memory_changes (xodo_id, agency_id, batch, item_id, op, actor, after, reason)
select i.xodo_id, i.agency_id, b.batch, i.id, 'importar', 'sistema',
       jsonb_build_object('n', i.n, 'content', i.content, 'status', i.status), 'memória antiga em texto'
  from public.xodo_memory_items i join batches b on b.xodo_id = i.xodo_id;

drop table public.xodo_memory_revisions;
drop table public.xodo_memories;

-- ---------------------------------------------------------------------------
-- Acesso: só leitura para quem é da agência; toda escrita passa pelo servidor
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['xodo_memory_topics', 'xodo_memory_items', 'xodo_memory_changes', 'xodo_memory_captures'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.app_is_agency_member(agency_id))',
      t || '_member_read', t);
  end loop;
end $$;

grant select on public.xodo_memory_topics, public.xodo_memory_changes, public.xodo_memory_captures to authenticated;
grant select (id, xodo_id, agency_id, n, topic, client_id, kind, content, source, status, pinned, valid_until,
              superseded_by, confidence, kept_in_core, run_id, created_by, version, created_at, updated_at)
  on public.xodo_memory_items to authenticated;
