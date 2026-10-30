-- Marca da agência guardada no servidor (antes ficava só no navegador de quem configurou) e domínio
-- próprio do portal do cliente. A logo fica numa coluna à parte (até ~1 MB em data URL) e é servida
-- por uma rota pública com cache; o resto da marca vai junto dos dados da agência.

alter table public.agencies add column if not exists brand jsonb not null default '{}'::jsonb
  check (jsonb_typeof(brand) = 'object' and pg_column_size(brand) <= 4000);
alter table public.agencies add column if not exists logo_data text
  check (logo_data is null or (logo_data ~ '^data:image/(png|jpeg|webp|svg\+xml);base64,' and char_length(logo_data) <= 1500000));
alter table public.agencies add column if not exists logo_updated_at timestamptz;

create table public.agency_domains (
  agency_id uuid primary key references public.agencies(id) on delete cascade,
  domain text not null unique check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and char_length(domain) <= 253),
  -- pendente: esperando o DNS; ativo: verificado na Vercel e apontando certo; erro: a Vercel recusou.
  status text not null default 'pendente' check (status in ('pendente', 'ativo', 'erro')),
  -- Registros que a agência precisa criar no DNS (como a Vercel pede).
  records jsonb not null default '[]'::jsonb,
  error text check (char_length(error) <= 400),
  checked_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.agency_domains enable row level security;
